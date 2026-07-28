import WebSocket, { type RawData } from "ws";
import type { DomainEvent } from "@mamachi/protocol";
import type { CapturedContext } from "./artifact-store.ts";
import type {
  PlaybackCursor,
  VoiceConnectKeys,
  VoiceBridge,
  VoiceHostCallbacks,
  VoiceResponseMode,
  VoiceToolHost,
  VoiceToolkit,
} from "./voice-bridge.ts";
import { createVoiceToolkit } from "./voice-toolkit.ts";
import type { VoiceBrief, VoiceBriefKind } from "./voice-brief-store.ts";
export type RealtimeResponseMode = VoiceResponseMode;

export type RealtimePlaybackCursor = PlaybackCursor;

type QueuedBrief = VoiceBrief;
type QueuedBriefKind = VoiceBriefKind;

interface RealtimeBridgeOptions extends VoiceHostCallbacks {
  apiKey?: string;
  model?: string;
  voice?: string;
  endpoint?: string;
  initialBriefs?: readonly VoiceBrief[];
  onBriefQueued?: (brief: VoiceBrief) => void;
  onBriefDelivered?: (taskIds: readonly string[]) => void;
  emitAudio: (pcm: Uint8Array, playback: { itemId: string; contentIndex: number }) => void;
  initiallyEngaged?: boolean;
  reconnectDelaysMs?: readonly number[];
  responseTimeoutMs?: number;
  cancellationTimeoutMs?: number;
}

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export class RealtimeBridge implements VoiceBridge {
  readonly #options: RealtimeBridgeOptions;
  readonly #model: string;
  readonly #voice: string;
  readonly #endpoint: string;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #responseTimeoutMs: number;
  readonly #cancellationTimeoutMs: number;
  readonly #toolkit: VoiceToolkit;
  #engaged: boolean;
  readonly #queuedBriefs = new Map<string, QueuedBrief>();
  readonly #announcedQuestionIds = new Set<string>();
  #activeAssistantAudio: { itemId: string; contentIndex: number } | null = null;
  #lastTruncation: RealtimePlaybackCursor | null = null;
  #apiKey: string | undefined;
  #socket: WebSocket | null = null;
  #manualClose = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #responseWatchdog: ReturnType<typeof setTimeout> | null = null;
  #responseActive = false;
  #responsePending = false;
  #inputActive = false;
  readonly #pendingUserTranscripts: string[] = [];
  #pendingExplicitUserInput: string | null = null;
  #responseExplicitUserInput: string | null = null;
  #responseAwaitingTranscription = false;
  #suppressAudio = false;
  #cancellationRequested = false;
  #responseMode: RealtimeResponseMode = "voice";
  #pendingResponseMode: RealtimeResponseMode | null = null;
  #toolChainDepth = 0;

  constructor(options: RealtimeBridgeOptions) {
    this.#options = options;
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "gpt-realtime-2.1";
    this.#voice = options.voice ?? "marin";
    this.#endpoint = options.endpoint ?? "wss://api.openai.com/v1/realtime";
    this.#reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? options.reconnectDelaysMs
      : [250, 1_000, 2_000, 5_000];
    this.#responseTimeoutMs = Math.max(1, options.responseTimeoutMs ?? 20_000);
    this.#cancellationTimeoutMs = Math.max(1, options.cancellationTimeoutMs ?? 2_000);
    this.#engaged = options.initiallyEngaged ?? true;
    for (const brief of options.initialBriefs ?? []) this.#queuedBriefs.set(brief.taskId, brief);
    this.#toolkit = createVoiceToolkit(this.#createHost());
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
      getCurrentUserInput: () => this.#responseExplicitUserInput,
      sleepMicrophone: () => {
        this.setEngaged(false);
        this.#options.emit("ui.mute", {});
      },
      attachUserImage: (note, dataUrl) => {
        this.#send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: note },
              { type: "input_image", image_url: dataUrl, detail: "high" },
            ],
          },
        });
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

  async connect(keys: VoiceConnectKeys = {}): Promise<void> {
    if (keys.openaiApiKey) this.#apiKey = keys.openaiApiKey;
    this.#cancelReconnect();
    if (!this.#apiKey) throw new Error("OpenAI Realtime requires an API key");
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#socket) await this.disconnect();

    this.#manualClose = false;
    this.#clearResponseWatchdog();
    this.#responseActive = false;
    this.#responsePending = false;
    this.#inputActive = false;
    this.#discardPendingUserTranscripts();
    this.#pendingExplicitUserInput = null;
    this.#responseExplicitUserInput = null;
    this.#responseAwaitingTranscription = false;
    this.#suppressAudio = false;
    this.#cancellationRequested = false;
    this.#toolChainDepth = 0;
    this.#activeAssistantAudio = null;
    this.#lastTruncation = null;
    this.#options.emit("voice.state", { state: "connecting" });
    const separator = this.#endpoint.includes("?") ? "&" : "?";
    const socket = new WebSocket(`${this.#endpoint}${separator}model=${encodeURIComponent(this.#model)}`, {
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
    });
    this.#socket = socket;
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearResponseWatchdog();
      this.#responseActive = false;
      this.#responsePending = false;
      this.#inputActive = false;
      this.#discardPendingUserTranscripts();
      this.#pendingExplicitUserInput = null;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      this.#suppressAudio = false;
      this.#cancellationRequested = false;
      this.#activeAssistantAudio = null;
      this.#lastTruncation = null;
      this.#toolkit.clearPendingComputerControls("provider_connection_closed");
      if (!this.#manualClose) {
        this.#options.emit("voice.state", { state: "disconnected", reason: "provider_connection_closed" });
        this.#scheduleReconnect();
      }
    });

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("OpenAI Realtime session setup timed out"));
    }, 20_000);

    socket.once("open", () => {
      this.#send(this.#sessionUpdate());
    });
    socket.on("message", (data) => {
      void this.#handleMessage(data);
      if (settled) return;
      try {
        const event = JSON.parse(data.toString()) as unknown;
        if (!isObject(event)) return;
        if (event["type"] === "session.updated") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (event["type"] === "error") {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(this.#errorMessage(event)));
        }
      } catch {
        // The permanent message handler reports malformed provider events.
      }
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    await promise;
    this.#reconnectAttempt = 0;
    for (const context of this.#toolkit.pendingContexts()) this.#injectContext(context);
    this.#announceOpenQuestions();
    this.#flushBriefs();
  }

  async disconnect(): Promise<void> {
    this.#manualClose = true;
    this.#cancelReconnect();
    const socket = this.#socket;
    this.#socket = null;
    this.#clearResponseWatchdog();
    this.#responseActive = false;
    this.#responsePending = false;
    this.#inputActive = false;
    this.#discardPendingUserTranscripts();
    this.#pendingExplicitUserInput = null;
    this.#responseExplicitUserInput = null;
    this.#responseAwaitingTranscription = false;
    this.#suppressAudio = false;
    this.#cancellationRequested = false;
    this.#toolChainDepth = 0;
    this.#activeAssistantAudio = null;
    this.#lastTruncation = null;
    this.#toolkit.clearPendingComputerControls("voice_disconnected");
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timeout = setTimeout(resolve, 2_000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.close(1000, "Voice disengaged");
      await promise;
    }
    this.#options.emit("voice.state", { state: "disconnected" });
  }

  #cancelReconnect(): void {
    if (!this.#reconnectTimer) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #scheduleReconnect(): void {
    if (this.#manualClose || this.#reconnectTimer || !this.#apiKey) return;
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
      if (this.#manualClose) return;
      void this.connect().catch((error: unknown) => {
        if (this.#manualClose) return;
        this.#options.emit("voice.reconnect_failed", {
          attempt: this.#reconnectAttempt,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#scheduleReconnect();
      });
    }, delayMs);
  }

  appendAudio(pcm: Uint8Array): void {
    if (!this.#engaged || pcm.byteLength === 0 || this.#socket?.readyState !== WebSocket.OPEN) return;
    const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
    this.#send({ type: "input_audio_buffer.append", audio });
  }

  setEngaged(engaged: boolean, playback: RealtimePlaybackCursor | null = null): void {
    if (this.#engaged === engaged) {
      if (!engaged && playback) this.#truncatePlayback(playback);
      return;
    }
    this.#engaged = engaged;
    this.#options.emit(engaged ? "voice.engaged" : "voice.disengaged", {
      pendingBrief: this.#queuedBriefs.size > 0,
    });
    if (engaged) {
      this.#announceOpenQuestions();
      this.#flushBriefs();
      return;
    }
    this.#inputActive = false;
    this.#pendingExplicitUserInput = null;
    this.#responseExplicitUserInput = null;
    this.#responseAwaitingTranscription = false;
    this.#suppressAudio = true;
    this.#toolChainDepth = 0;
    this.#pendingExplicitUserInput = null;
    this.#responseExplicitUserInput = null;
    this.#responseAwaitingTranscription = false;
    if (playback) this.#truncatePlayback(playback);
    if (this.#responseActive && !this.#cancellationRequested) {
      this.#cancellationRequested = true;
      this.#send({ type: "response.cancel" });
      this.#armResponseWatchdog(this.#cancellationTimeoutMs);
    }
    this.#options.emit("voice.state", { state: "idle" });
  }

  interrupt(playback: RealtimePlaybackCursor | null = null): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#toolChainDepth = 0;
    this.#suppressAudio = true;
    if (playback) this.#truncatePlayback(playback);
    if (this.#responseActive && !this.#cancellationRequested) {
      this.#cancellationRequested = true;
      this.#send({ type: "response.cancel" });
      this.#armResponseWatchdog(this.#cancellationTimeoutMs);
    }
    this.#options.emit("voice.interrupt", {});
    this.#options.emit("voice.state", { state: "listening" });
  }

  setResponseMode(mode: RealtimeResponseMode): void {
    if (this.#responseActive) {
      this.#pendingResponseMode = mode;
      return;
    }
    this.#responseMode = mode;
    this.#pendingResponseMode = null;
    if (this.#socket?.readyState === WebSocket.OPEN) this.#send(this.#sessionUpdate());
    this.#options.emit("voice.mode", { mode });
  }

  refreshComputerControlConfiguration(): void {
    this.#toolkit.clearPendingComputerControls("settings_changed");
    if (this.#socket?.readyState === WebSocket.OPEN) this.#send(this.#sessionUpdate());
  }

  sendText(text: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    this.#requireOpenSocket();
    this.#toolChainDepth = 0;
    this.#pendingExplicitUserInput = normalized;
    this.#responseAwaitingTranscription = false;
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }],
      },
    });
    this.#requestResponse();
  }
  captureContext(context: CapturedContext): void {
    this.#toolkit.captureContext(context);
    if (this.#socket?.readyState === WebSocket.OPEN) this.#injectContext(context);
  }

  discardContext(id: string): void {
    this.#toolkit.discardContext(id);
  }


  handleTaskEvents(events: readonly DomainEvent[]): void {
    if (events.length === 0) return;
    const relevant = events.filter((event) =>
      [
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
      ].includes(event.type),
    );
    if (relevant.length === 0) return;
    for (const event of relevant) {
      if (event.type === "task.questionAsked") this.#announcedQuestionIds.add(event.payload.questionId);
    }
    const announcements = relevant.filter((event) =>
      event.type === "task.awaitingUser" ||
      event.type === "task.questionAsked" ||
      event.type === "task.completed" ||
      event.type === "task.failed" ||
      event.type === "workspace.conflictDetected"
    );
    if (this.#socket?.readyState !== WebSocket.OPEN || (this.#responseMode === "voice" && !this.#engaged)) {
      for (const event of announcements) this.#queueBrief(event);
      return;
    }
    this.#injectTaskUpdate(relevant, announcements.length > 0);
    if (announcements.length > 0) this.#requestResponse();
  }

  #injectTaskUpdate(events: readonly DomainEvent[], announce: boolean): void {
    const snapshot = this.#options.getSnapshot();
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
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
          },
        ],
      },
    });
  }
  #announceOpenQuestions(): void {
    if (this.#socket?.readyState !== WebSocket.OPEN || (this.#responseMode === "voice" && !this.#engaged)) return;
    const questions = (this.#options.getSnapshot().questions ?? []).filter((question) =>
      question.state === "open" &&
      !this.#announcedQuestionIds.has(question.id) &&
      !this.#queuedBriefs.has(question.taskId)
    );
    if (questions.length === 0) return;
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{
          type: "input_text",
          text: [
            "The coding agent is already waiting for user input. Ask each exact open question now; do not call get_task_status first.",
            JSON.stringify(questions.map((question) => ({
              questionId: question.id,
              taskId: question.taskId,
              question: question.question,
            }))),
          ].join("\n"),
        }],
      },
    });
    for (const question of questions) this.#announcedQuestionIds.add(question.id);
    this.#requestResponse();
  }


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

  #briefFor(event: DomainEvent): QueuedBrief | null {
    if (!event.taskId) return null;
    const payload: Record<string, unknown> = isObject(event.payload) ? event.payload : {};
    const detail =
      typeof payload["question"] === "string" ? payload["question"] :
      typeof payload["summary"] === "string" ? payload["summary"] :
      typeof payload["error"] === "string" ? payload["error"] :
      typeof payload["reason"] === "string" ? payload["reason"] :
      event.type;
    const kind: QueuedBriefKind =
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
    if (this.#queuedBriefs.size === 0 || this.#socket?.readyState !== WebSocket.OPEN) return;
    if (this.#responseMode === "voice" && !this.#engaged) return;
    const briefs = [...this.#queuedBriefs.values()];
    this.#send({
      type: "conversation.item.create",
      item: {
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
      },
    });
    this.#requestResponse();
    for (const brief of briefs) this.#queuedBriefs.delete(brief.taskId);
    this.#options.onBriefDelivered?.(briefs.map((brief) => brief.taskId));
    this.#options.emit("brief.delivered", { count: briefs.length });
  }

  noteHarnessEvent(type: string, payload: unknown): void {
    this.#toolkit.noteHarnessEvent(type, payload);
  }
  #injectContext(context: CapturedContext): void {
    const serialized = JSON.stringify(context.payload);
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
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
          },
        ],
      },
    });
  }


  #sessionUpdate(): unknown {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        model: this.#model,
        output_modalities: [this.#responseMode === "voice" ? "audio" : "text"],
        instructions: this.#toolkit.instructions(),
        reasoning: { effort: "low" },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: {
              model: "gpt-4o-mini-transcribe",
              prompt: "The user speaks English or Turkish. Ignore music, streams, and background speech.",
            },
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.65,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
              create_response: false,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            voice: this.#voice,
          },
        },
        tools: this.#toolkit.tools(),
        tool_choice: "auto",
        parallel_tool_calls: false,
      },
    };
  }



  async #handleMessage(data: RawData): Promise<void> {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data.toString()) as unknown;
      if (!isObject(parsed)) throw new Error("Provider event is not an object");
      event = parsed;
    } catch (error) {
      this.#options.emit("voice.error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const type = event["type"];
    if (typeof type === "string" && type.startsWith("response.") && type !== "response.done") {
      this.#armResponseWatchdog(
        this.#cancellationRequested ? this.#cancellationTimeoutMs : this.#responseTimeoutMs,
      );
    }
    if (type === "session.updated") {
      this.#options.emit("voice.state", { state: "connected", model: this.#model, voice: this.#voice });
    } else if (type === "input_audio_buffer.speech_started") {
      if (!this.#engaged) return;
      this.#inputActive = true;
      this.#pendingExplicitUserInput = null;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      this.#toolChainDepth = 0;
      if (this.#responseActive) this.#suppressAudio = true;
      this.#options.emit("voice.interrupt", {});
      this.#options.emit("voice.state", { state: "listening" });
    } else if (type === "input_audio_buffer.speech_stopped") {
      if (!this.#engaged) return;
      this.#inputActive = false;
      this.#options.emit("voice.state", { state: "thinking" });
      this.#responseAwaitingTranscription = true;
      this.#requestResponse();
    } else if (type === "conversation.item.input_audio_transcription.delta") {
      if (this.#engaged && typeof event["delta"] === "string") {
        this.#options.emit("voice.transcript.user_delta", { text: event["delta"] });
      }
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      if (this.#engaged && typeof event["transcript"] === "string") {
        const transcript = event["transcript"].trim();
        if (transcript) {
          this.#pendingUserTranscripts.push(transcript);
          this.#pendingExplicitUserInput = transcript;
          if (
            this.#responseActive &&
            this.#responseAwaitingTranscription &&
            !this.#cancellationRequested &&
            !this.#responsePending
          ) {
            this.#responseExplicitUserInput = transcript;
            this.#pendingExplicitUserInput = null;
            this.#responseAwaitingTranscription = false;
          }
          this.#options.emit("voice.transcript.user_pending", { text: transcript });
        }
      }
    } else if (type === "response.output_audio.delta") {
      if (
        this.#engaged &&
        typeof event["delta"] === "string" &&
        typeof event["item_id"] === "string" &&
        Number.isInteger(event["content_index"]) &&
        !this.#suppressAudio
      ) {
        this.#flushPendingUserTranscripts();
        const playback = {
          itemId: event["item_id"],
          contentIndex: event["content_index"] as number,
        };
        if (
          this.#activeAssistantAudio?.itemId !== playback.itemId ||
          this.#activeAssistantAudio.contentIndex !== playback.contentIndex
        ) {
          this.#lastTruncation = null;
        }
        this.#activeAssistantAudio = playback;
        const audio = Buffer.from(event["delta"], "base64");
        this.#options.emit("voice.audio", playback);
        this.#options.emitAudio(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength), playback);
        this.#options.emit("voice.state", { state: "speaking" });
      }
    } else if (type === "response.output_audio_transcript.delta") {
      if (!this.#suppressAudio && typeof event["delta"] === "string") {
        this.#flushPendingUserTranscripts();
        this.#options.emit("voice.transcript.assistant_delta", { text: event["delta"] });
      }
    } else if (type === "response.output_audio_transcript.done") {
      if (!this.#suppressAudio && typeof event["transcript"] === "string") {
        this.#flushPendingUserTranscripts();
        this.#options.emit("voice.transcript.assistant", { text: event["transcript"] });
      }
    } else if (type === "response.output_text.delta") {
      if (!this.#suppressAudio && typeof event["delta"] === "string") {
        this.#flushPendingUserTranscripts();
        this.#options.emit("voice.transcript.assistant_delta", { text: event["delta"] });
      }
    } else if (type === "response.output_text.done") {
      if (!this.#suppressAudio && typeof event["text"] === "string") {
        this.#flushPendingUserTranscripts();
        this.#options.emit("voice.transcript.assistant", { text: event["text"] });
      }
    } else if (type === "response.done") {
      this.#clearResponseWatchdog();
      this.#responseActive = false;
      this.#cancellationRequested = false;
      if (this.#pendingResponseMode) {
        this.#responseMode = this.#pendingResponseMode;
        this.#pendingResponseMode = null;
        this.#send(this.#sessionUpdate());
        this.#options.emit("voice.mode", { mode: this.#responseMode });
      }
      await this.#handleResponseDone(event);
    } else if (type === "error") {
      const message = this.#errorMessage(event);
      if (this.#cancellationRequested && /no active response/i.test(message)) {
        this.#responseActive = false;
        this.#cancellationRequested = false;
        this.#responseExplicitUserInput = null;
        this.#responseAwaitingTranscription = false;
        if (this.#responsePending) {
          this.#responsePending = false;
          this.#requestResponse();
        } else {
          this.#options.emit("voice.state", { state: this.#engaged ? "listening" : "idle" });
        }
        return;
      }
      this.#clearResponseWatchdog();
      this.#responseActive = false;
      this.#responsePending = false;
      this.#suppressAudio = !this.#engaged;
      this.#cancellationRequested = false;
      this.#pendingExplicitUserInput = null;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      this.#flushPendingUserTranscripts();
      this.#options.emit("voice.error", { error: message });
    }
  }



  async #handleResponseDone(event: Record<string, unknown>): Promise<void> {
    const response = event["response"];
    if (!isObject(response)) return;
    const output = response["output"];
    const calls: FunctionCall[] = [];
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!isObject(item) || item["type"] !== "function_call") continue;
        if (typeof item["call_id"] !== "string" || typeof item["name"] !== "string" || typeof item["arguments"] !== "string") {
          continue;
        }
        calls.push({
          callId: item["call_id"],
          name: item["name"],
          arguments: item["arguments"],
        });
      }
    }
    if (calls.length > 0 && calls.every((call) => call.name === "wait_for_user")) {
      this.#discardPendingUserTranscripts();
    } else {
      this.#flushPendingUserTranscripts();
    }

    if (calls.length === 0 && this.#responsePending) {
      this.#toolChainDepth = 0;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      this.#requestResponse();
      return;
    }
    if (calls.length === 0) {
      this.#toolChainDepth = 0;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      this.#options.emit("voice.state", { state: "idle" });
      return;
    }
    this.#toolChainDepth += 1;

    for (const call of calls) {
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
      this.#send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(result),
        },
      });
    }
    if (calls.some((call) => call.name === "mute_mamachi")) {
      this.#toolChainDepth = 0;
      this.#responsePending = false;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      this.#options.emit("voice.state", { state: "idle" });
      return;
    }
    if (calls.every((call) => call.name === "wait_for_user")) {
      this.#toolChainDepth = 0;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      if (this.#responsePending) {
        this.#requestResponse();
      } else {
        this.#options.emit("voice.state", { state: "idle" });
      }
      return;
    }
    if (this.#toolChainDepth >= 4) {
      this.#toolChainDepth = 0;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      this.#options.emit("voice.error", {
        error: "Voice tool chain stopped after four consecutive tool rounds",
      });
      this.#options.emit("voice.state", { state: "idle" });
      return;
    }
    const continueCurrentUserTurn = this.#pendingExplicitUserInput === null;
    this.#requestResponse(continueCurrentUserTurn);
  }

  #flushPendingUserTranscripts(): void {
    if (this.#pendingUserTranscripts.length === 0) return;
    const transcripts = this.#pendingUserTranscripts.splice(0);
    for (const text of transcripts) this.#options.emit("voice.transcript.user", { text });
  }

  #discardPendingUserTranscripts(): void {
    this.#pendingUserTranscripts.length = 0;
    this.#options.emit("voice.transcript.user_discarded", {});
  }










  #clearResponseWatchdog(): void {
    if (!this.#responseWatchdog) return;
    clearTimeout(this.#responseWatchdog);
    this.#responseWatchdog = null;
  }

  #armResponseWatchdog(timeoutMs = this.#responseTimeoutMs): void {
    if (!this.#responseActive) return;
    this.#clearResponseWatchdog();
    this.#responseWatchdog = setTimeout(() => {
      this.#responseWatchdog = null;
      if (!this.#responseActive) return;
      const cancelled = this.#cancellationRequested;
      this.#responseActive = false;
      this.#responsePending = false;
      this.#cancellationRequested = false;
      this.#suppressAudio = true;
      this.#pendingExplicitUserInput = null;
      this.#responseExplicitUserInput = null;
      this.#responseAwaitingTranscription = false;
      if (!cancelled) {
        this.#announcedQuestionIds.clear();
        this.#options.emit("voice.error", {
          error: "OpenAI Realtime stopped responding. Reconnecting automatically.",
          recoverable: true,
        });
      }
      const socket = this.#socket;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close(1012, cancelled ? "Cancellation timed out" : "Response timed out");
      }
    }, timeoutMs);
  }

  #requestResponse(preserveUserInput = false): void {
    if (!this.#engaged && this.#responseMode === "voice") {
      this.#responsePending = false;
      return;
    }

    if (this.#responseActive || this.#inputActive) {
      this.#responsePending = true;
      return;
    }
    this.#responsePending = false;
    if (!preserveUserInput) {
      this.#responseExplicitUserInput = this.#pendingExplicitUserInput;
      this.#pendingExplicitUserInput = null;
      if (this.#responseExplicitUserInput) this.#responseAwaitingTranscription = false;
    }
    this.#responseActive = true;
    this.#suppressAudio = false;
    this.#options.emit("voice.state", { state: "thinking" });
    this.#send({ type: "response.create" });
    this.#armResponseWatchdog();
  }

  #truncatePlayback(playback: RealtimePlaybackCursor): void {
    if (
      !this.#activeAssistantAudio ||
      playback.itemId !== this.#activeAssistantAudio.itemId ||
      playback.contentIndex !== this.#activeAssistantAudio.contentIndex ||
      !Number.isInteger(playback.audioEndMs) ||
      playback.audioEndMs < 0 ||
      (this.#lastTruncation?.itemId === playback.itemId &&
        this.#lastTruncation.contentIndex === playback.contentIndex)
    ) {
      return;
    }
    const normalized = {
      ...playback,
      audioEndMs: Math.max(0, playback.audioEndMs),
    };
    this.#lastTruncation = normalized;
    this.#send({
      type: "conversation.item.truncate",
      item_id: normalized.itemId,
      content_index: normalized.contentIndex,
      audio_end_ms: normalized.audioEndMs,
    });
  }

  #send(event: unknown): void {
    this.#requireOpenSocket().send(JSON.stringify(event));
  }

  #requireOpenSocket(): WebSocket {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI Realtime session is not connected");
    }
    return this.#socket;
  }

  #errorMessage(event: Record<string, unknown>): string {
    const error = event["error"];
    if (!isObject(error)) return "OpenAI Realtime returned an unknown error";
    const message = error["message"];
    return typeof message === "string" ? message : "OpenAI Realtime returned an unknown error";
  }
}
