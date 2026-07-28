import WebSocket, { type RawData } from "ws";
import type { DomainEvent } from "@mamachi/protocol";
import type { CapturedContext } from "./artifact-store.ts";
import type { VoiceBrief, VoiceBriefKind } from "./voice-brief-store.ts";
import {
  defaultCascadeLlmModel,
  defaultCascadeReasoningEffort,
  defaultCascadeVoiceId,
  defaultSttModelId,
  defaultTtsModelId,
} from "./voice-bridge.ts";
import type {
  CascadeBridgeOptions,
  CascadeReasoningEffort,
  PlaybackCursor,
  VoiceBridge,
  VoiceConnectKeys,
  VoiceResponseMode,
  VoiceToolHost,
  VoiceToolkit,
} from "./voice-bridge.ts";

const defaultResponsesEndpoint = "https://api.openai.com/v1/responses";
const defaultSttEndpoint = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const defaultTtsEndpoint = "wss://api.elevenlabs.io/v1/text-to-speech";

/// Scribe errors that invalidate the session or account; no reconnect helps.
const fatalScribeErrorTypes: Record<string, true> = {
  auth_error: true,
  quota_exceeded: true,
};
/// Scribe errors the session survives (or a plain reconnect fixes).
const recoverableScribeErrorTypes: Record<string, true> = {
  error: true,
  commit_throttled: true,
  rate_limited: true,
  queue_overflow: true,
  resource_exhausted: true,
  session_time_limit_exceeded: true,
  input_error: true,
  chunk_size_exceeded: true,
  insufficient_audio_activity: true,
  transcriber_error: true,
};

const relevantTaskEventTypes: readonly string[] = [
  "task.started",
  "task.pauseRequested",
  "task.paused",
  "task.awaitingUser",
  "task.questionAsked",
  "task.specRevised",
  "task.resumed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "workspace.conflictDetected",
  "workspace.conflictResolved",
];

const announcementTaskEventTypes: readonly string[] = [
  "task.awaitingUser",
  "task.questionAsked",
  "task.completed",
  "task.failed",
  "workspace.conflictDetected",
];

interface MessageContent {
  type: "input_text" | "output_text";
  text: string;
}

interface ImageContent {
  type: "input_image";
  image_url: string;
  detail: "high";
}

interface MessageItem {
  type: "message";
  role: "user" | "assistant" | "system";
  content: [MessageContent] | [MessageContent, ImageContent];
}

type HistoryItem =
  | MessageItem
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

/// With `auto_mode=true`, Flash triggers a generation for whatever text each
/// SendText carries. Raw Responses-API deltas are token-sized, so forwarding
/// them verbatim produces choppy word-by-word prosody; the bridge assembles
/// sentences (or bounded phrases) before anything crosses the TTS socket.
const ttsSentenceBoundary = /(?:[.!?…]+["'")\]»”’]*\s+|\n+)/g;
/// A lone boundary shorter than this (abbreviation, one-word sentence) waits
/// and rides with the following sentence for smoother prosody.
const ttsMinChunkChars = 12;
/// Run-on text without any boundary is cut at a word break past this size so
/// buffering stays bounded; ~250-char phrases still sound natural.
const ttsMaxBufferedChars = 250;

interface ActiveTurn {
  itemId: string;
  contentIndex: number;
  controller: AbortController;
  userInput: string | null;
  /// Full assistant text streamed so far across every tool round of the turn.
  text: string;
  /// Absolute char → start-ms timeline. Flash alignment times are relative to
  /// each audio chunk, so entries are pushed with the running offset applied.
  timeline: Array<{ char: string; startMs: number }>;
  /// Running milliseconds of PCM received (bytes / 48 at 24kHz int16 mono).
  audioMsOffset: number;
  tts: WebSocket | null;
  ttsOpen: boolean;
  ttsQueue: string[];
  /// LLM text accumulated since the last chunk handed to the TTS socket.
  ttsPending: string;
  ttsCloseRequested: boolean;
  ttsDone: PromiseWithResolvers<void> | null;
  assistantItem: MessageItem | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/// Cascaded voice pipeline: ElevenLabs Scribe v2 Realtime (STT) → OpenAI
/// Responses API (LLM) → ElevenLabs Flash v2.5 stream-input (TTS). Emits the
/// same `voice.*`/`brief.*` events the app already consumes from
/// `RealtimeBridge`; conversation history lives in-process as Responses API
/// input items.
export class CascadeBridge implements VoiceBridge {
  readonly #options: CascadeBridgeOptions;
  readonly #toolkit: VoiceToolkit;
  readonly #llmModel: string;
  readonly #reasoningEffort: CascadeReasoningEffort;
  readonly #voiceId: string;
  readonly #sttModelId: string;
  readonly #ttsModelId: string;
  readonly #responsesEndpoint: string;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #history: HistoryItem[] = [];
  /// Live screenshot attachments awaiting end-of-turn detachment.
  readonly #imageItems: MessageItem[] = [];
  readonly #queuedBriefs = new Map<string, VoiceBrief>();
  #openaiApiKey: string | undefined;
  #elevenLabsApiKey: string | undefined;
  #connected = false;
  #engaged: boolean;
  #manualClose = false;
  #responseMode: VoiceResponseMode = "voice";
  #pendingResponseMode: VoiceResponseMode | null = null;
  #scribe: WebSocket | null = null;
  #scribeStarted = false;
  #scribeFatal = false;
  #pendingPartial: string | null = null;
  /// One-shot log guards so the permanent stderr diagnostics stay quiet at
  /// audio-chunk/partial rates; reset on every engagement change.
  #audioForwardLogged = false;
  #audioDropLogged = false;
  #partialLogged = false;
  #audioChunkCount = 0;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #turn: ActiveTurn | null = null;
  #lastTurn: ActiveTurn | null = null;
  #lastTruncation: PlaybackCursor | null = null;

  constructor(options: CascadeBridgeOptions) {
    this.#options = options;
    this.#openaiApiKey = options.openaiApiKey;
    this.#elevenLabsApiKey = options.elevenLabsApiKey;
    this.#llmModel = options.llmModel ?? defaultCascadeLlmModel;
    this.#reasoningEffort = options.reasoningEffort ?? defaultCascadeReasoningEffort;
    // RuntimeSettings persists "" for "use the default voice" (Rachel).
    this.#voiceId = options.voiceId || defaultCascadeVoiceId;
    this.#sttModelId = options.sttModelId ?? defaultSttModelId;
    this.#ttsModelId = options.ttsModelId ?? defaultTtsModelId;
    this.#responsesEndpoint = options.responsesEndpoint ?? defaultResponsesEndpoint;
    this.#reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? options.reconnectDelaysMs
      : [250, 1_000, 2_000, 5_000];
    this.#engaged = options.initiallyEngaged ?? true;
    for (const brief of options.initialBriefs ?? []) this.#queuedBriefs.set(brief.taskId, brief);
    this.#toolkit = options.createToolkit(this.#createHost());
  }

  async connect(keys: VoiceConnectKeys = {}): Promise<void> {
    if (keys.openaiApiKey) this.#openaiApiKey = keys.openaiApiKey;
    if (keys.elevenLabsApiKey) this.#elevenLabsApiKey = keys.elevenLabsApiKey;
    this.#cancelReconnect();
    if (!this.#openaiApiKey) throw new Error("Cascade voice requires an OpenAI API key");
    if (!this.#elevenLabsApiKey) throw new Error("Cascade voice requires an ElevenLabs API key");
    this.#manualClose = false;
    this.#options.emit("voice.state", { state: "connecting" });
    this.#connected = true;
    if (this.#engaged) {
      try {
        await this.#openScribe();
      } catch (error) {
        this.#connected = false;
        throw error;
      }
    }
    this.#reconnectAttempt = 0;
    this.#options.emit("voice.state", { state: "connected", model: this.#llmModel, voice: this.#voiceId });
    if (this.#engaged) this.#options.emit("voice.state", { state: "listening" });
    for (const context of this.#toolkit.pendingContexts()) this.#injectContextNote(context);
    this.#flushBriefs();
  }

  async disconnect(): Promise<void> {
    this.#manualClose = true;
    this.#connected = false;
    this.#cancelReconnect();
    this.#discardPendingPartial();
    this.#abortActiveTurn();
    this.#lastTurn = null;
    this.#lastTruncation = null;
    this.#closeScribe();
    this.#toolkit.clearPendingComputerControls("voice_disconnected");
    this.#options.emit("voice.state", { state: "disconnected" });
  }

  /// Releases toolkit timers. Call after `disconnect()` when replacing the
  /// bridge (e.g. cascade parameter changes rebuild it).
  dispose(): void {
    this.#toolkit.dispose();
  }

  appendAudio(pcm: Uint8Array): void {
    if (!this.#engaged || pcm.byteLength === 0) {
      this.#logAudioDrop(this.#engaged ? "empty_chunk" : "not_engaged");
      return;
    }
    const socket = this.#scribe;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.#logAudioDrop(socket ? `scribe_state_${socket.readyState}` : "scribe_missing");
      return;
    }
    this.#audioChunkCount += 1;
    if (!this.#audioForwardLogged || this.#audioChunkCount % 50 === 0) {
      this.#audioForwardLogged = true;
      // int16 RMS 0..1: distinguishes real speech (>0.01 typically) from a
      // voice-processing chain that is shipping near-silence while the
      // pill's boosted waveform still looks alive.
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 8) {
        const v = (samples[i] ?? 0) / 32768;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / Math.max(1, Math.ceil(samples.length / 8)));
      this.#log("audio.to_scribe", { bytes: pcm.byteLength, chunk: this.#audioChunkCount, rms: Number(rms.toFixed(4)) });
    }
    socket.send(JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
      commit: false,
      sample_rate: 24_000,
    }));
  }

  #log(at: string, detail: Record<string, unknown> = {}): void {
    console.error(`[mamachi.voice] ${JSON.stringify({ at, bridge: "cascade", ...detail })}`);
  }

  #logAudioDrop(reason: string): void {
    if (this.#audioDropLogged) return;
    this.#audioDropLogged = true;
    this.#log("audio.dropped", { reason });
  }

  setEngaged(engaged: boolean, playback: PlaybackCursor | null = null): void {
    if (this.#engaged === engaged) {
      if (!engaged && playback) {
        const turn = this.#turn ?? this.#lastTurn;
        if (turn) this.#truncateAssistant(turn, playback);
      }
      return;
    }
    this.#engaged = engaged;
    this.#audioForwardLogged = false;
    this.#audioDropLogged = false;
    this.#partialLogged = false;
    this.#audioChunkCount = 0;
    this.#log("engaged", { engaged, connected: this.#connected, scribeOpen: this.#scribeStarted });
    this.#options.emit(engaged ? "voice.engaged" : "voice.disengaged", {
      pendingBrief: this.#queuedBriefs.size > 0,
    });
    if (engaged) {
      if (!this.#connected) return;
      void this.#openScribe().then(() => {
        if (this.#engaged && this.#connected && !this.#turn) {
          this.#options.emit("voice.state", { state: "listening" });
        }
      }).catch((error: unknown) => {
        this.#options.emit("voice.error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.#flushBriefs();
      return;
    }
    const turn = this.#turn ?? this.#lastTurn;
    this.#abortActiveTurn();
    if (playback && turn) this.#truncateAssistant(turn, playback);
    this.#discardPendingPartial();
    this.#cancelReconnect();
    this.#closeScribe();
    if (this.#connected) this.#options.emit("voice.state", { state: "connected" });
  }

  interrupt(playback: PlaybackCursor | null = null): void {
    if (!this.#connected) return;
    const turn = this.#turn ?? this.#lastTurn;
    this.#abortActiveTurn();
    if (playback && turn) this.#truncateAssistant(turn, playback);
    this.#options.emit("voice.interrupt", {});
    this.#options.emit("voice.state", { state: "listening" });
  }

  setResponseMode(mode: VoiceResponseMode): void {
    if (this.#turn) {
      this.#pendingResponseMode = mode;
      return;
    }
    this.#responseMode = mode;
    this.#pendingResponseMode = null;
    this.#options.emit("voice.mode", { mode });
  }

  sendText(text: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    if (!this.#connected) throw new Error("Cascade voice session is not connected");
    this.#history.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: normalized }],
    });
    this.#startTurn(normalized);
  }

  captureContext(context: CapturedContext): void {
    this.#toolkit.captureContext(context);
    if (this.#connected) this.#injectContextNote(context);
  }

  discardContext(id: string): void {
    this.#toolkit.discardContext(id);
  }

  handleTaskEvents(events: readonly DomainEvent[]): void {
    if (events.length === 0) return;
    const relevant = events.filter((event) => relevantTaskEventTypes.includes(event.type));
    if (relevant.length === 0) return;
    const announcements = relevant.filter((event) => announcementTaskEventTypes.includes(event.type));
    if (!this.#connected || (this.#responseMode === "voice" && !this.#engaged)) {
      for (const event of announcements) this.#queueBrief(event);
      return;
    }
    this.#injectTaskUpdate(relevant, announcements.length > 0);
    if (announcements.length > 0) this.#startTurn();
  }

  noteHarnessEvent(type: string, payload: unknown): void {
    this.#toolkit.noteHarnessEvent(type, payload);
  }

  refreshComputerControlConfiguration(): void {
    this.#toolkit.clearPendingComputerControls("settings_changed");
  }

  #createHost(): VoiceToolHost {
    const options = this.#options;
    const host: VoiceToolHost = {
      getWorkspace: options.getWorkspace,
      getSnapshot: options.getSnapshot,
      executeCommand: options.executeCommand,
      emit: options.emit,
      isEngaged: () => this.#engaged,
      getResponseMode: () => this.#responseMode,
      getCurrentUserInput: () => this.#turn?.userInput ?? null,
      sleepMicrophone: () => {
        this.setEngaged(false);
        this.#options.emit("ui.mute", {});
      },
      attachUserImage: (note: string, dataUrl: string) => {
        const item: MessageItem = {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: note },
            { type: "input_image", image_url: dataUrl, detail: "high" },
          ],
        };
        this.#history.push(item);
        this.#imageItems.push(item);
        this.#log("vision.attached", { bytes: dataUrl.length });
      },
    };
    if (options.getAvailableWorkspaces) host.getAvailableWorkspaces = options.getAvailableWorkspaces;
    if (options.getCodingProfiles) host.getCodingProfiles = options.getCodingProfiles;
    if (options.getComputerCapabilities) host.getComputerCapabilities = options.getComputerCapabilities;
    if (options.getComputerConfirmationMode) host.getComputerConfirmationMode = options.getComputerConfirmationMode;
    if (options.getTaskFacts) host.getTaskFacts = options.getTaskFacts;
    if (options.getTaskArtifact) host.getTaskArtifact = options.getTaskArtifact;
    if (options.captureEditorContext) host.captureEditorContext = options.captureEditorContext;
    if (options.askCoder) host.askCoder = options.askCoder;
    if (options.steerCoder) host.steerCoder = options.steerCoder;
    if (options.followUpCoder) host.followUpCoder = options.followUpCoder;
    if (options.rememberFact) host.rememberFact = options.rememberFact;
    if (options.forgetFact) host.forgetFact = options.forgetFact;
    if (options.controlComputer) host.controlComputer = options.controlComputer;
    if (options.captureScreenContext) host.captureScreenContext = options.captureScreenContext;
    return host;
  }

  // ==== STT: ElevenLabs Scribe v2 Realtime ====

  #openScribe(): Promise<void> {
    const existing = this.#scribe;
    if (existing && existing.readyState === WebSocket.OPEN && this.#scribeStarted) {
      return Promise.resolve();
    }
    if (existing) this.#closeScribe();
    const key = this.#elevenLabsApiKey;
    if (!key) return Promise.reject(new Error("Cascade voice requires an ElevenLabs API key"));
    this.#scribeFatal = false;
    const base = this.#options.sttEndpoint ?? defaultSttEndpoint;
    const separator = base.includes("?") ? "&" : "?";
    const url = `${base}${separator}model_id=${encodeURIComponent(this.#sttModelId)}` +
      "&audio_format=pcm_24000&commit_strategy=vad&vad_silence_threshold_secs=0.6";
    this.#log("scribe.opening", {});
    const socket = new WebSocket(url, { headers: { "xi-api-key": key } });
    this.#scribe = socket;
    this.#scribeStarted = false;

    const setup = Promise.withResolvers<void>();
    let settled = false;
    const timeout = setTimeout(() => {
      settle(() => {
        socket.close();
        setup.reject(new Error("ElevenLabs Scribe session setup timed out"));
      });
    }, 10_000);
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    socket.on("message", (data) => {
      if (this.#scribe !== socket) return;
      const outcome = this.#handleScribeMessage(socket, data);
      if (outcome === "started") settle(() => setup.resolve());
      else if (outcome instanceof Error) settle(() => setup.reject(outcome));
    });
    socket.on("error", (error) => {
      // Persistent: a second error after settlement must not crash the
      // process as an unhandled 'error' event.
      settle(() => setup.reject(error));
    });
    socket.on("close", (code: number) => {
      if (this.#scribe !== socket) return;
      this.#log("scribe.closed", { code, engaged: this.#engaged, fatal: this.#scribeFatal });
      this.#scribe = null;
      this.#scribeStarted = false;
      this.#discardPendingPartial();
      settle(() => setup.reject(new Error("ElevenLabs Scribe connection closed during setup")));
      if (!this.#manualClose && this.#connected && this.#engaged && !this.#scribeFatal) {
        this.#scheduleReconnect();
      }
    });
    return setup.promise;
  }

  #handleScribeMessage(socket: WebSocket, data: RawData): "started" | Error | undefined {
    let event: unknown;
    try {
      event = JSON.parse(data.toString()) as unknown;
    } catch {
      this.#options.emit("voice.error", { error: "ElevenLabs Scribe sent a malformed event", recoverable: true });
      return undefined;
    }
    if (!isObject(event) || typeof event["message_type"] !== "string") {
      this.#log("scribe.unhandled", { shape: typeof event });
      return undefined;
    }
    const type = event["message_type"];
    if (type === "session_started") {
      this.#scribeStarted = true;
      this.#log("scribe.started", { session: event["session_id"] });
      return "started";
    }
    if (type === "partial_transcript") {
      const text = event["text"];
      if (this.#engaged && typeof text === "string" && text.length > 0) {
        if (!this.#partialLogged) {
          this.#partialLogged = true;
          this.#log("scribe.partial", { chars: text.length });
        }
        this.#pendingPartial = text;
        this.#options.emit("voice.transcript.user_pending", { text });
      }
      return undefined;
    }
    if (type === "committed_transcript") {
      const text = event["text"];
      if (this.#engaged && typeof text === "string" && text.trim().length > 0) {
        this.#log("scribe.committed", { chars: text.length });
        this.#pendingPartial = null;
        this.#options.emit("voice.transcript.user", { text });
        this.#history.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        });
        this.#startTurn(text.trim());
      }
      return undefined;
    }
    if (type === "final_transcript") return undefined;
    if (fatalScribeErrorTypes[type]) {
      const message = typeof event["error"] === "string" && event["error"].length > 0
        ? event["error"]
        : `ElevenLabs Scribe reported ${type}`;
      this.#log("scribe.fatal", { type, message });
      this.#scribeFatal = true;
      this.#discardPendingPartial();
      this.#options.emit("voice.state", { state: "error" });
      this.#options.emit("voice.error", { error: message });
      if (this.#scribe === socket) {
        this.#scribe = null;
        this.#scribeStarted = false;
        try {
          socket.close();
        } catch {
          // Already closing; nothing to release.
        }
      }
      return new Error(message);
    }
    if (recoverableScribeErrorTypes[type]) {
      const message = typeof event["error"] === "string" && event["error"].length > 0
        ? event["error"]
        : `ElevenLabs Scribe reported ${type}`;
      this.#log("scribe.recoverable", { type, message });
      this.#options.emit("voice.error", { error: message, recoverable: true });
      return undefined;
    }
    // A type the AsyncAPI spec did not prepare us for (e.g. *_with_timestamps
    // variants) would otherwise vanish silently — exactly the failure mode
    // that looks like "it does not hear me".
    this.#log("scribe.unhandled", { type });
    return undefined;
  }

  #closeScribe(): void {
    const socket = this.#scribe;
    if (!socket) return;
    this.#scribe = null;
    this.#scribeStarted = false;
    try {
      socket.close(1000, "Voice disengaged");
    } catch {
      // Socket already closing.
    }
  }

  #cancelReconnect(): void {
    if (!this.#reconnectTimer) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #scheduleReconnect(): void {
    if (this.#manualClose || this.#reconnectTimer || !this.#connected || !this.#engaged) return;
    const delayIndex = Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1);
    const delayMs = Math.max(0, this.#reconnectDelaysMs[delayIndex] ?? 5_000);
    this.#reconnectAttempt += 1;
    this.#options.emit("voice.state", {
      state: "connecting",
      reason: "provider_reconnecting",
      attempt: this.#reconnectAttempt,
      retryInMs: delayMs,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#manualClose || !this.#connected || !this.#engaged) return;
      this.#openScribe().then(() => {
        this.#reconnectAttempt = 0;
        if (this.#engaged && this.#connected && !this.#turn) {
          this.#options.emit("voice.state", { state: "listening" });
        }
      }).catch((error: unknown) => {
        this.#options.emit("voice.reconnect_failed", {
          attempt: this.#reconnectAttempt,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#scheduleReconnect();
      });
    }, delayMs);
  }

  #discardPendingPartial(): void {
    if (this.#pendingPartial === null) return;
    this.#pendingPartial = null;
    this.#options.emit("voice.transcript.user_discarded", {});
  }

  // ==== Turn engine: Responses API + Flash v2.5 ====

  #startTurn(userInput: string | null = null): void {
    this.#abortActiveTurn();
    this.#detachStaleImages();
    this.#log("turn.start", { history: this.#history.length, mode: this.#responseMode });
    const turn: ActiveTurn = {
      itemId: Bun.randomUUIDv7(),
      contentIndex: 0,
      controller: new AbortController(),
      text: "",
      userInput,
      timeline: [],
      audioMsOffset: 0,
      tts: null,
      ttsOpen: false,
      ttsQueue: [],
      ttsPending: "",
      ttsCloseRequested: false,
      ttsDone: null,
      assistantItem: null,
    };
    this.#turn = turn;
    this.#options.emit("voice.state", { state: "thinking" });
    void this.#runTurn(turn);
  }

  /// Images ride only the turn they were captured in: the cascade re-sends
  /// the FULL history with every Responses request, so a Retina screenshot
  /// left in place would be re-uploaded on every future turn. The realtime
  /// engine keeps images server-side; one-turn retention is the cascade's
  /// equivalent.
  #detachStaleImages(): void {
    if (this.#imageItems.length === 0) return;
    for (const item of this.#imageItems.splice(0)) {
      item.content = [{
        type: "input_text",
        text: "[A screenshot was attached here and inspected during its turn. It was detached afterward to keep requests small; call look_at_screen again if the screen must be re-read.]",
      }];
    }
    this.#log("vision.detached", {});
  }

  #abortActiveTurn(): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    this.#lastTurn = turn;
    turn.controller.abort();
    this.#closeTts(turn);
  }

  async #runTurn(turn: ActiveTurn): Promise<void> {
    try {
      let rounds = 0;
      for (;;) {
        const calls = await this.#streamLlmRound(turn);
        if (this.#turn !== turn) return;
        if (calls.length === 0) break;
        rounds += 1;
        for (const call of calls) {
          this.#history.push({
            type: "function_call",
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments,
          });
          let result: unknown;
          try {
            const args = JSON.parse(call.arguments) as unknown;
            result = await this.#toolkit.execute(call.name, args);
          } catch (error) {
            result = {
              status: "rejected",
              explanation: error instanceof Error ? error.message : String(error),
            };
          }
          this.#history.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify(result),
          });
          if (this.#turn !== turn) return;
        }
        // `wait_for_user` and `mute_mamachi` end the turn like realtime:
        // record outputs, stop the chain, request nothing further.
        if (calls.every((call) => call.name === "wait_for_user")) break;
        if (calls.some((call) => call.name === "mute_mamachi")) break;
        // Interactive computer control (games, multi-step UI work) needs far
        // more than the old 4 rounds; the cap is a runaway brake, not a
        // budget — barge-in and mute remain the human stop. Realtime's own
        // cap lives in its bridge and should be aligned when it migrates
        // onto this toolkit.
        if (rounds >= 24) {
          this.#options.emit("voice.error", {
            error: "Voice tool chain stopped after 24 consecutive tool rounds",
          });
          break;
        }
      }
      // Hand any tail below the sentence threshold to the TTS before the
      // stream closes; nothing may remain buffered at turn end.
      if (this.#responseMode === "voice") this.#drainTtsSentences(turn, true);
      if (turn.text.length > 0) {
        const item: MessageItem = {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: turn.text }],
        };
        turn.assistantItem = item;
        this.#history.push(item);
        this.#options.emit("voice.transcript.assistant", { text: turn.text });
      }
      await this.#finishTts(turn);
      if (this.#turn !== turn) return;
      this.#turn = null;
      this.#lastTurn = turn;
      this.#applyPendingResponseMode();
      this.#options.emit("voice.state", { state: this.#engaged ? "listening" : "connected" });
    } catch (error) {
      const stale = this.#turn !== turn;
      this.#log("turn.failed", {
        stale,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.#turn === turn) {
        this.#turn = null;
        this.#lastTurn = turn;
      }
      this.#closeTts(turn);
      if (stale || (error instanceof Error && error.name === "AbortError")) return;
      this.#options.emit("voice.error", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.#options.emit("voice.state", {
        state: this.#engaged && this.#connected ? "listening" : "connected",
      });
    }
  }

  async #streamLlmRound(turn: ActiveTurn): Promise<FunctionCall[]> {
    const response = await fetch(this.#responsesEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.#llmModel,
        instructions: this.#toolkit.instructions(),
        input: [...this.#history],
        tools: this.#toolkit.tools(),
        reasoning: { effort: this.#reasoningEffort },
        stream: true,
        store: false,
      }),
      signal: turn.controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenAI Responses request failed with status ${response.status}`);
    }
    const body = response.body;
    if (!body) throw new Error("OpenAI Responses returned no response body");

    const calls: FunctionCall[] = [];
    let completed = false;
    const decoder = new TextDecoder();
    let buffered = "";
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: unknown;
        try {
          event = JSON.parse(payload) as unknown;
        } catch {
          continue;
        }
        if (!isObject(event)) continue;
        const type = event["type"];
        if (type === "response.output_text.delta") {
          const delta = event["delta"];
          if (typeof delta === "string" && delta.length > 0) this.#handleLlmDelta(turn, delta);
        } else if (type === "response.output_item.done") {
          const item = event["item"];
          if (
            isObject(item) &&
            item["type"] === "function_call" &&
            typeof item["call_id"] === "string" &&
            typeof item["name"] === "string" &&
            typeof item["arguments"] === "string"
          ) {
            calls.push({ callId: item["call_id"], name: item["name"], arguments: item["arguments"] });
          }
        } else if (type === "response.completed") {
          completed = true;
        } else if (type === "response.failed" || type === "error") {
          throw new Error(this.#llmErrorMessage(event));
        }
      }
    }
    if (!completed) throw new Error("OpenAI Responses stream ended before completion");
    return calls;
  }

  #llmErrorMessage(event: Record<string, unknown>): string {
    const response = event["response"];
    if (isObject(response)) {
      const error = response["error"];
      if (isObject(error) && typeof error["message"] === "string") return error["message"];
    }
    if (typeof event["message"] === "string") return event["message"];
    const error = event["error"];
    if (isObject(error) && typeof error["message"] === "string") return error["message"];
    return "OpenAI Responses returned an unknown error";
  }

  #handleLlmDelta(turn: ActiveTurn, delta: string): void {
    if (this.#turn !== turn) return;
    turn.text += delta;
    this.#options.emit("voice.transcript.assistant_delta", { text: delta });
    if (this.#responseMode === "voice") {
      turn.ttsPending += delta;
      this.#drainTtsSentences(turn);
    }
  }

  /// Cuts `ttsPending` at the LAST complete sentence boundary (merging
  /// too-short leading sentences into their successor), with a word-break
  /// overflow valve for boundary-free run-on text. `final` flushes the
  /// remainder when the LLM stream is done.
  #drainTtsSentences(turn: ActiveTurn, final = false): void {
    const pending = turn.ttsPending;
    let cut = 0;
    ttsSentenceBoundary.lastIndex = 0;
    for (let match = ttsSentenceBoundary.exec(pending); match; match = ttsSentenceBoundary.exec(pending)) {
      cut = match.index + match[0].length;
    }
    if (cut < ttsMinChunkChars) cut = 0;
    if (cut === 0 && pending.length > ttsMaxBufferedChars) {
      const wordBreak = pending.lastIndexOf(" ", ttsMaxBufferedChars);
      cut = wordBreak > 0 ? wordBreak + 1 : pending.length;
    }
    if (cut > 0) {
      turn.ttsPending = pending.slice(cut);
      this.#sendTtsChunk(turn, pending.slice(0, cut));
    }
    if (final && turn.ttsPending.length > 0) {
      const remainder = turn.ttsPending;
      turn.ttsPending = "";
      this.#sendTtsChunk(turn, remainder);
    }
  }

  #sendTtsChunk(turn: ActiveTurn, chunk: string): void {
    // Flash wants clean chunks ending in a single space; collapse the
    // whitespace we split on. Alignment/truncation are unaffected: the
    // timeline is built from the characters Flash reports back.
    const text = `${chunk.replace(/\s+/g, " ").trimEnd()} `;
    if (text.trim().length === 0) return;
    this.#ensureTts(turn);
    const socket = turn.tts;
    if (socket && turn.ttsOpen) socket.send(JSON.stringify({ text }));
    else turn.ttsQueue.push(text);
  }

  #ensureTts(turn: ActiveTurn): void {
    if (turn.tts) return;
    const key = this.#elevenLabsApiKey;
    if (!key) return;
    const base = this.#options.ttsEndpoint ?? defaultTtsEndpoint;
    const url = `${base}/${encodeURIComponent(this.#voiceId)}/stream-input` +
      `?model_id=${encodeURIComponent(this.#ttsModelId)}` +
      "&output_format=pcm_24000&auto_mode=true&sync_alignment=true";
    this.#log("tts.opening", {});
    const socket = new WebSocket(url, { headers: { "xi-api-key": key } });
    turn.tts = socket;
    turn.ttsDone = Promise.withResolvers<void>();
    socket.on("open", () => {
      if (turn.tts !== socket) return;
      socket.send(JSON.stringify({ text: " " }));
      for (const text of turn.ttsQueue.splice(0)) socket.send(JSON.stringify({ text }));
      turn.ttsOpen = true;
      if (turn.ttsCloseRequested) socket.send(JSON.stringify({ text: "" }));
    });
    socket.on("message", (data) => {
      if (turn.tts !== socket) return;
      this.#handleTtsMessage(turn, data);
    });
    socket.on("error", (error) => {
      this.#options.emit("voice.error", {
        error: `ElevenLabs TTS error: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      });
    });
    socket.on("close", () => {
      if (turn.tts !== socket) return;
      turn.tts = null;
      turn.ttsOpen = false;
      turn.ttsDone?.resolve();
    });
  }

  #handleTtsMessage(turn: ActiveTurn, data: RawData): void {
    let event: unknown;
    try {
      event = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }
    if (!isObject(event)) return;
    const audio = event["audio"];
    if (typeof audio === "string" && audio.length > 0) {
      const pcm = Buffer.from(audio, "base64");
      const chunkBaseMs = turn.audioMsOffset;
      const alignment = event["alignment"];
      if (isObject(alignment)) {
        const chars = alignment["chars"];
        const starts = alignment["charStartTimesMs"];
        if (Array.isArray(chars) && Array.isArray(starts)) {
          for (let i = 0; i < chars.length; i += 1) {
            const char = chars[i];
            const start = starts[i];
            if (typeof char === "string" && typeof start === "number") {
              turn.timeline.push({ char, startMs: chunkBaseMs + start });
            }
          }
        }
      }
      // 24kHz mono int16 PCM: 48 bytes per millisecond.
      turn.audioMsOffset += pcm.byteLength / 48;
      if (this.#turn === turn) {
        const playback = { itemId: turn.itemId, contentIndex: turn.contentIndex };
        this.#options.emit("voice.audio", playback);
        this.#options.emitAudio(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), playback);
        this.#options.emit("voice.state", { state: "speaking" });
      }
    }
    if (event["isFinal"] === true) turn.ttsDone?.resolve();
  }

  async #finishTts(turn: ActiveTurn): Promise<void> {
    const socket = turn.tts;
    if (!socket) return;
    turn.ttsCloseRequested = true;
    if (turn.ttsOpen) socket.send(JSON.stringify({ text: "" }));
    const done = turn.ttsDone;
    if (done) {
      const timeout = setTimeout(() => done.resolve(), 10_000);
      await done.promise;
      clearTimeout(timeout);
    }
    this.#closeTts(turn);
  }

  #closeTts(turn: ActiveTurn): void {
    const socket = turn.tts;
    if (!socket) return;
    turn.tts = null;
    turn.ttsOpen = false;
    try {
      socket.close(1000);
    } catch {
      // Socket already closing.
    }
    turn.ttsDone?.resolve();
  }

  #applyPendingResponseMode(): void {
    const pending = this.#pendingResponseMode;
    if (pending === null) return;
    this.#pendingResponseMode = null;
    this.#responseMode = pending;
    this.#options.emit("voice.mode", { mode: pending });
  }

  /// Truncate the assistant turn to what the user actually heard. Alignment
  /// entries carry absolute start-ms; keep the prefix whose start-ms is at or
  /// before the playback cursor. Without alignment the whole pending text is
  /// dropped.
  #truncateAssistant(turn: ActiveTurn, playback: PlaybackCursor): void {
    if (
      playback.itemId !== turn.itemId ||
      playback.contentIndex !== turn.contentIndex ||
      !Number.isInteger(playback.audioEndMs) ||
      playback.audioEndMs < 0 ||
      (this.#lastTruncation?.itemId === playback.itemId &&
        this.#lastTruncation.contentIndex === playback.contentIndex)
    ) {
      return;
    }
    this.#lastTruncation = { ...playback };
    let heard = "";
    for (const entry of turn.timeline) {
      if (entry.startMs > playback.audioEndMs) break;
      heard += entry.char;
    }
    turn.text = heard;
    if (turn.assistantItem) {
      if (heard.length === 0) {
        const index = this.#history.indexOf(turn.assistantItem);
        if (index !== -1) this.#history.splice(index, 1);
        turn.assistantItem = null;
        return;
      }
      const content = turn.assistantItem.content[0];
      content.text = heard;
      return;
    }
    if (heard.length === 0) return;
    const item: MessageItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: heard }],
    };
    turn.assistantItem = item;
    this.#history.push(item);
  }

  // ==== Briefs, task events, context notes ====

  #queueBrief(event: DomainEvent): void {
    const brief = this.#briefFor(event);
    if (!brief) return;
    this.#queuedBriefs.set(brief.taskId, brief);
    this.#options.onBriefQueued?.(brief);
    this.#options.emit("brief.queued", {
      taskId: brief.taskId,
      kind: brief.kind,
      summary: brief.summary,
      pending: this.#queuedBriefs.size,
    });
    if (!this.#engaged) {
      this.#options.emit("voice.notification", {
        eventId: event.id,
        taskId: brief.taskId,
        ...brief.notification,
      });
    }
  }

  #briefFor(event: DomainEvent): VoiceBrief | null {
    if (!event.taskId) return null;
    const payload: Record<string, unknown> = isObject(event.payload) ? event.payload : {};
    const detail =
      typeof payload["question"] === "string" ? payload["question"] :
      typeof payload["summary"] === "string" ? payload["summary"] :
      typeof payload["error"] === "string" ? payload["error"] :
      typeof payload["reason"] === "string" ? payload["reason"] :
      event.type;
    const kind: VoiceBriefKind =
      event.type === "task.completed" ? "completed" :
      event.type === "task.failed" ? "failed" :
      "awaiting_user";
    const notificationKind =
      kind === "completed" ? "completion" :
      kind === "failed" ? "failure" :
      "attention";
    const title =
      notificationKind === "attention" ? "Coder needs your attention" :
      notificationKind === "failure" ? "Coding task failed" :
      "Coding task finished";
    const summary = detail.trim().slice(0, 1_200);
    return {
      taskId: event.taskId,
      kind,
      summary,
      queuedAt: new Date().toISOString(),
      notification: {
        title,
        body: summary.slice(0, 220),
        kind: notificationKind,
      },
    };
  }

  #flushBriefs(): void {
    if (this.#queuedBriefs.size === 0 || !this.#connected) return;
    if (this.#responseMode === "voice" && !this.#engaged) return;
    const briefs = [...this.#queuedBriefs.values()];
    this.#history.push({
      type: "message",
      role: "system",
      content: [{
        type: "input_text",
        text: [
          "Mamachi resumed after sleeping. Give exactly one short spoken brief covering every queued authoritative coding update below. Do not call get_task_status first.",
          JSON.stringify({
            briefs: briefs.map((brief) => ({
              taskId: brief.taskId,
              kind: brief.kind,
              summary: brief.summary,
              queuedAt: brief.queuedAt,
              facts: this.#options.getTaskFacts?.(brief.taskId) ?? null,
            })),
          }).slice(0, 16_000),
        ].join("\n"),
      }],
    });
    this.#startTurn();
    for (const brief of briefs) this.#queuedBriefs.delete(brief.taskId);
    this.#options.onBriefDelivered?.(briefs.map((brief) => brief.taskId));
    this.#options.emit("brief.delivered", { count: briefs.length });
  }

  #injectTaskUpdate(events: readonly DomainEvent[], announce: boolean): void {
    const snapshot = this.#options.getSnapshot();
    this.#history.push({
      type: "message",
      role: "system",
      content: [{
        type: "input_text",
        text: [
          announce
            ? "The coding agent has a user-visible update. Proactively tell the user now without waiting for a status question. For completion or failure, give the outcome in one short sentence. For awaiting input, ask the exact question. This event is authoritative; do not call get_task_status first."
            : "Mamachi controller state update. Treat this as authoritative; do not reply unless the user asks or a separate response is requested.",
          JSON.stringify({
            workspace: this.#options.getWorkspace(),
            activeTaskId: snapshot.activeTaskId,
            queue: snapshot.queue,
            events: events.map((event) => ({
              type: event.type,
              taskId: event.taskId ?? null,
              payload: event.payload,
            })),
            facts: [
              ...new Set(events.flatMap((event) => event.taskId ? [event.taskId] : [])),
            ].flatMap((taskId) => {
              const facts = this.#options.getTaskFacts?.(taskId);
              return facts ? [facts] : [];
            }),
          }),
        ].join("\n"),
      }],
    });
  }

  #injectContextNote(context: CapturedContext): void {
    const serialized = JSON.stringify(context.payload);
    this.#history.push({
      type: "message",
      role: "system",
      content: [{
        type: "input_text",
        text: [
          "The user explicitly captured editor context. It will be attached once to the next submitted coding task. Treat it as user-provided evidence and do not reply unless the user asks or a separate response is requested.",
          JSON.stringify({
            id: context.id,
            kind: context.kind,
            summary: context.summary,
            payloadExcerpt: serialized.slice(0, 16_000),
            truncated: serialized.length > 16_000,
          }),
        ].join("\n"),
      }],
    });
  }
}
