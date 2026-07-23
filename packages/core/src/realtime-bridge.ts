import WebSocket, { type RawData } from "ws";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import type { ControllerSnapshot, TaskRecord } from "./domain.ts";
import type { CapturedContext, ContextKind, EvidenceArtifact } from "./artifact-store.ts";
import {
  computerActions,
  parseComputerControlRequest,
  sensitiveComputerActions,
} from "./computer-control.ts";
import type {
  ComputerAction,
  ComputerCapability,
  ComputerConfirmationMode,
  ComputerControlRequest,
  ComputerControlResult,
} from "./computer-control.ts";
import type { TaskFacts } from "./fact-projector.ts";
import type { MemoryScope } from "./memory-store.ts";
import type { VoiceBrief, VoiceBriefKind } from "./voice-brief-store.ts";
export type RealtimeResponseMode = "voice" | "text";

export interface RealtimePlaybackCursor {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

type QueuedBrief = VoiceBrief;
type QueuedBriefKind = VoiceBriefKind;

interface RealtimeBridgeOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  endpoint?: string;
  getWorkspace: () => string;
  getAvailableWorkspaces?: () => readonly string[];
  getCodingProfiles?: () => readonly string[];
  getComputerCapabilities?: () => readonly ComputerCapability[];
  getComputerConfirmationMode?: () => ComputerConfirmationMode;
  getSnapshot: () => ControllerSnapshot;
  getTaskFacts?: (taskId: string) => TaskFacts | undefined;
  getTaskArtifact?: (taskId: string, artifactId: string) => EvidenceArtifact | null;
  executeCommand: (command: unknown) => Promise<ActionResult>;
  captureEditorContext?: (kinds: readonly ContextKind[]) => Promise<{
    artifacts: Array<{ id: string; kind: ContextKind; summary: string }>;
    errors: Array<{ kind: ContextKind; error: string }>;
  }>;
  askCoder?: (taskId: string, question: string) => Promise<boolean>;
  steerCoder?: (taskId: string, clarification: string) => Promise<boolean>;
  followUpCoder?: (taskId: string, addition: string) => Promise<boolean>;
  rememberFact?: (scope: MemoryScope, projectId: string | null, fact: string) => {
    id: string;
    scope: MemoryScope;
    projectId: string | null;
    fact: string;
  };
  forgetFact?: (memoryId: string) => boolean;
  initialBriefs?: readonly VoiceBrief[];
  onBriefQueued?: (brief: VoiceBrief) => void;
  onBriefDelivered?: (taskIds: readonly string[]) => void;
  controlComputer?: (request: ComputerControlRequest) => Promise<ComputerControlResult>;
  emit: (type: string, payload: unknown) => void;
  emitAudio: (pcm: Uint8Array, playback: { itemId: string; contentIndex: number }) => void;
  initiallyEngaged?: boolean;
  reconnectDelaysMs?: readonly number[];
}

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

interface PendingComputerControl {
  request: ComputerControlRequest;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function requireStringArray(value: unknown, name: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must contain at least one item`);
  return value.map((item) => item.trim());
}

function assertOnlyKeys(input: Record<string, unknown>, keys: readonly string[], tool: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${tool} does not accept ${unexpected}`);
}

function requireNullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requireString(value, name);
}

export class RealtimeBridge {
  readonly #options: RealtimeBridgeOptions;
  readonly #model: string;
  readonly #voice: string;
  readonly #endpoint: string;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #recentActivity = new Map<string, { type: string; summary: string; at: string }>();
  readonly #pendingContext = new Map<string, CapturedContext>();
  readonly #pendingComputerControls = new Map<string, PendingComputerControl>();
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
  #responseActive = false;
  #responsePending = false;
  #inputActive = false;
  readonly #pendingUserTranscripts: string[] = [];
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
    this.#engaged = options.initiallyEngaged ?? true;
    for (const brief of options.initialBriefs ?? []) this.#queuedBriefs.set(brief.taskId, brief);
  }

  async connect(apiKey?: string): Promise<void> {
    if (apiKey) this.#apiKey = apiKey;
    this.#cancelReconnect();
    if (!this.#apiKey) throw new Error("OpenAI Realtime requires an API key");
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#socket) await this.disconnect();

    this.#manualClose = false;
    this.#responseActive = false;
    this.#responsePending = false;
    this.#inputActive = false;
    this.#discardPendingUserTranscripts();
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
      this.#responseActive = false;
      this.#responsePending = false;
      this.#inputActive = false;
      this.#discardPendingUserTranscripts();
      this.#suppressAudio = false;
      this.#cancellationRequested = false;
      this.#activeAssistantAudio = null;
      this.#lastTruncation = null;
      this.#clearPendingComputerControls("provider_connection_closed");
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
    for (const context of this.#pendingContext.values()) this.#injectContext(context);
    this.#announceOpenQuestions();
    this.#flushBriefs();
  }

  async disconnect(): Promise<void> {
    this.#manualClose = true;
    this.#cancelReconnect();
    const socket = this.#socket;
    this.#socket = null;
    this.#responseActive = false;
    this.#responsePending = false;
    this.#inputActive = false;
    this.#discardPendingUserTranscripts();
    this.#suppressAudio = false;
    this.#cancellationRequested = false;
    this.#toolChainDepth = 0;
    this.#activeAssistantAudio = null;
    this.#lastTruncation = null;
    this.#clearPendingComputerControls("voice_disconnected");
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
      this.#flushBriefs();
      return;
    }
    this.#inputActive = false;
    this.#suppressAudio = true;
    this.#toolChainDepth = 0;
    if (playback) this.#truncatePlayback(playback);
    if (this.#responseActive && !this.#cancellationRequested) {
      this.#cancellationRequested = true;
      this.#send({ type: "response.cancel" });
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
    this.#clearPendingComputerControls("settings_changed");
    if (this.#socket?.readyState === WebSocket.OPEN) this.#send(this.#sessionUpdate());
  }

  sendText(text: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    this.#toolChainDepth = 0;
    this.#requireOpenSocket();
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
    this.#pendingContext.set(context.id, context);
    if (this.#socket?.readyState === WebSocket.OPEN) this.#injectContext(context);
  }

  discardContext(id: string): void {
    this.#pendingContext.delete(id);
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
    if (!isObject(payload) || typeof payload["taskId"] !== "string") return;
    const taskId = payload["taskId"];
    let summary = type;
    if (typeof payload["toolName"] === "string") summary = `${type}: ${payload["toolName"]}`;
    if (typeof payload["text"] === "string") summary = payload["text"].slice(0, 600);
    if (typeof payload["error"] === "string") summary = payload["error"].slice(0, 600);
    this.#recentActivity.set(taskId, { type, summary, at: new Date().toISOString() });
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
        instructions: this.#instructions(),
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
        tools: this.#tools(),
        tool_choice: "auto",
        parallel_tool_calls: false,
      },
    };
  }

  #instructions(): string {
    return `
# Role
You are Mamachi, a realtime voice companion bridging the user and a separate coding agent. Keep talking naturally while coding runs independently.

# Authority
The local controller and tool results are authoritative for workspace, task, queue, progress, and completion. Never claim a transition or verification without a successful tool result or controller state update. You cannot read or edit files and must not pretend to.

# Conversation versus action
Brainstorming, hypotheticals, examples, and side discussion are non-operative. A concrete coding request belongs to the coding agent: call submit_task when the objective, at least one observable acceptance criterion, and constraints are clear. For a broad request, summarize it and obtain confirmation first. Ask one question at a time.

# Active work
Coding continues after submit_task returns. Stay available for unrelated conversation. For status, use get_task_status. Do not narrate routine tools. Surface blockers, consequential changes, requested status, and completion. Controller completion, failure, and input-needed events require an immediate brief update; never wait for the user to ask.

# Workspace inspection
You cannot inspect the repository yourself. Any request whose answer depends on current workspace state—including latest commits, branches, files, code, dependencies, tests, diagnostics, or logs—MUST call inspect_workspace. Never answer these from memory and never ask the user to run a command for you.

# Web research
For current facts or web lookup, call research_web instead of answering from memory. Research runs through the coding agent and must return source URLs.

# Preambles
Do not speak before any tool call. Status checks, interface controls, workspace inspection, and task commands must be called immediately and silently. For a coding or research handoff, call the tool silently, then acknowledge it in one short sentence only after the tool succeeds. Never start a tool turn with filler such as "Let me check," "I'll look that up," or "One moment."

# Interface control
When the user says "expand", asks to open the orb, or asks to show the conversation or current task, call set_overlay with action "expand". When the user asks to collapse, minimize, or return to the orb, call set_overlay with action "collapse".

# Computer control
Use control_computer only for an explicit user request to operate this Mac. Enabled capability categories: ${(this.#options.getComputerCapabilities?.() ?? []).join(", ") || "none"}. Confirmation policy: ${this.#options.getComputerConfirmationMode?.() ?? "sensitive"}. You can operate inside applications, not only open or quit them: open or activate the app, inspect its accessibility UI, click a named UI element, set a field value, select a menu item, type text, send shortcuts, or use the pointer. For an in-app request, chain the smallest necessary actions and inspect again to verify the visible result. Prefer named structured UI actions over coordinates, and structured actions over raw AppleScript or shell. If an enabled action fails, report the exact tool error instead of claiming the app cannot be controlled. If a call returns confirmation_required, briefly name the action and ask for confirmation, then call resolve_computer_control with that exact request ID after the user's explicit decision. Never repeat a pending action, invent approval, expose clipboard contents unless requested, or claim success before an ok result.

# Microphone control
When the user says "mute", "go to sleep", "stop listening", or otherwise explicitly asks Mamachi to stop listening, call mute_mamachi immediately and silently. Do not acknowledge afterward because the microphone will be disengaged. The user can resume with the hotkey or orb.

# Approvals
When a permission card is pending, resolve it only after an explicit user decision. Call resolve_confirmation with the exact confirmation ID and never reuse an earlier approval.

# Course correction
A changed requirement must use propose_task_change. Summarize consequential changes before applying them. The tool pauses at a safe boundary, versions the accepted specification, and resumes it; never claim success before its result.

# Control
Use control_task only for an explicit pause, resume, or cancel request. A barge-in does not imply cancellation.

# Style
Default to one short spoken sentence of at most 20 words. Do not restate the request or narrate your reasoning. Ask one brief question only when required. Task status gives only outcome, current step, or blocker. Give additional detail only when the user explicitly asks. Never give progress percentages or time estimates. Mirror the user's language and preserve technical identifiers verbatim.

# Audio
If audio is unclear, ask briefly rather than guessing. If audio is silence, media, background speech, or not addressed to you, call wait_for_user and remain silent.

# Current workspace
${this.#options.getWorkspace()}
`;
  }

  #tools(): unknown[] {
    const emptyParameters = { type: "object", additionalProperties: false, properties: {}, required: [] };
    return [
      {
        type: "function",
        name: "wait_for_user",
        description: "End the turn silently when audio is not addressed to Mamachi or needs no response.",
        parameters: emptyParameters,
      },
      {
        type: "function",
        name: "get_workspace",
        description: "Read the active workspace or available repository choices.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { view: { type: "string", enum: ["active", "available"] } },
          required: ["view"],
        },
      },
      {
        type: "function",
        name: "list_coding_profiles",
        description: "List coding profiles accepted by submit_task.",
        parameters: emptyParameters,
      },
      {
        type: "function",
        name: "capture_editor_context",
        description: "Explicitly request selected editor context kinds from a connected VS Code client.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            kinds: {
              type: "array",
              items: { type: "string", enum: ["active_file", "selection", "diagnostics", "terminal_excerpt"] },
              minItems: 1,
              maxItems: 4,
              uniqueItems: true,
            },
          },
          required: ["kinds"],
        },
      },
      {
        type: "function",
        name: "submit_task",
        description: "Start or queue a fully specified coding task in a selected repository.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            repositoryId: { type: "string", minLength: 1 },
            objective: { type: "string", minLength: 1 },
            acceptanceCriteria: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            constraints: { type: "array", items: { type: "string", minLength: 1 } },
            attachmentIds: { type: "array", items: { type: "string", minLength: 1 } },
            codingProfileId: { type: ["string", "null"] },
          },
          required: ["repositoryId", "objective", "acceptanceCriteria", "constraints", "attachmentIds", "codingProfileId"],
        },
      },
      {
        type: "function",
        name: "get_task_status",
        description: "Read one authoritative view of a task or the active task.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: ["string", "null"] },
            view: {
              type: "string",
              enum: ["brief", "current_step", "plan", "queue", "changes", "verification", "decisions"],
            },
          },
          required: ["taskId", "view"],
        },
      },
      {
        type: "function",
        name: "get_task_artifact",
        description: "Read owned task evidence as metadata or a bounded excerpt.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: "string", minLength: 1 },
            artifactId: { type: "string", minLength: 1 },
            view: { type: "string", enum: ["summary", "bounded_excerpt"] },
          },
          required: ["taskId", "artifactId", "view"],
        },
      },
      {
        type: "function",
        name: "answer_task_question",
        description: "Answer one exact open coder question by its request ID.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            requestId: { type: "string", minLength: 1 },
            answer: { type: "string", minLength: 1 },
          },
          required: ["requestId", "answer"],
        },
      },
      {
        type: "function",
        name: "ask_coder",
        description: "Ask the live coding agent a read-only question about its current repository context.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: "string", minLength: 1 },
            question: { type: "string", minLength: 1 },
          },
          required: ["taskId", "question"],
        },
      },
      {
        type: "function",
        name: "propose_task_change",
        description: "Conservatively pause, version, and resume a changed accepted task specification.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: "string", minLength: 1 },
            change: { type: "string", minLength: 1 },
            desiredOutcome: { type: ["string", "null"] },
            addedConstraints: { type: "array", items: { type: "string", minLength: 1 } },
          },
          required: ["taskId", "change", "desiredOutcome", "addedConstraints"],
        },
      },
      {
        type: "function",
        name: "control_task",
        description: "Pause, resume, or cancel a task after an explicit user request.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: "string", minLength: 1 },
            action: { type: "string", enum: ["pause", "resume", "cancel"] },
          },
          required: ["taskId", "action"],
        },
      },
      {
        type: "function",
        name: "manage_queue",
        description: "Reorder one queued task relative to the queue or another queued task.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: "string", minLength: 1 },
            operation: { type: "string", enum: ["move_first", "move_last", "move_before", "move_after"] },
            anchorTaskId: { type: ["string", "null"] },
          },
          required: ["taskId", "operation", "anchorTaskId"],
        },
      },
      {
        type: "function",
        name: "resolve_confirmation",
        description: "Approve or reject one exact pending visual confirmation after an explicit user decision.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            confirmationId: { type: "string", minLength: 1 },
            decision: { type: "string", enum: ["approve", "reject"] },
          },
          required: ["confirmationId", "decision"],
        },
      },
      {
        type: "function",
        name: "remember_fact",
        description: "Persist one explicit user-approved fact globally or for the active project.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: { type: "string", enum: ["global", "project"] },
            projectId: { type: ["string", "null"] },
            fact: { type: "string", minLength: 1 },
          },
          required: ["scope", "projectId", "fact"],
        },
      },
      {
        type: "function",
        name: "forget_fact",
        description: "Delete one exact explicit memory by ID.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { memoryId: { type: "string", minLength: 1 } },
          required: ["memoryId"],
        },
      },
      {
        type: "function",
        name: "inspect_workspace",
        description: "Delegate a read-only question about current repository state to the coding agent.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string", minLength: 1 },
            deliverable: { type: "string", minLength: 1 },
          },
          required: ["question", "deliverable"],
        },
      },
      {
        type: "function",
        name: "research_web",
        description: "Delegate a current-information or web-research request to the coding agent.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1 },
            deliverable: { type: "string", minLength: 1 },
          },
          required: ["query", "deliverable"],
        },
      },
      {
        type: "function",
        name: "set_overlay",
        description: "Silently expand or collapse the Mamachi interface.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { action: { type: "string", enum: ["expand", "collapse"] } },
          required: ["action"],
        },
      },
      {
        type: "function",
        name: "control_computer",
        description: "Perform one explicitly requested macOS action using the user's configured capability policy.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: computerActions },
            application: { type: "string", minLength: 1 },
            url: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1 },
            role: { type: "string", minLength: 1 },
            value: { type: "string" },
            menu: { type: "string", minLength: 1 },
            menuItem: { type: "string", minLength: 1 },
            text: { type: "string", minLength: 1 },
            key: { type: "string", minLength: 1 },
            keys: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: 5,
            },
            x: { type: "number" },
            y: { type: "number" },
            toX: { type: "number" },
            toY: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
            deltaX: { type: "number" },
            deltaY: { type: "number" },
            volume: { type: "number", minimum: 0, maximum: 100 },
            script: { type: "string", minLength: 1 },
            command: { type: "string", minLength: 1 },
            cwd: { type: "string", minLength: 1 },
            timeoutSeconds: { type: "number", minimum: 1, maximum: 300 },
          },
          required: ["action"],
        },
      },
      {
        type: "function",
        name: "resolve_computer_control",
        description: "Approve or reject one exact pending computer action after the user's explicit decision.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            requestId: { type: "string", minLength: 1 },
            decision: { type: "string", enum: ["approve", "reject"] },
          },
          required: ["requestId", "decision"],
        },
      },
      {
        type: "function",
        name: "mute_mamachi",
        description: "Immediately and silently stop listening until the user resumes.",
        parameters: emptyParameters,
      },
    ];
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
    if (type === "session.updated") {
      this.#options.emit("voice.state", { state: "connected", model: this.#model, voice: this.#voice });
    } else if (type === "input_audio_buffer.speech_started") {
      if (!this.#engaged) return;
      this.#inputActive = true;
      this.#toolChainDepth = 0;
      if (this.#responseActive) this.#suppressAudio = true;
      this.#options.emit("voice.interrupt", {});
      this.#options.emit("voice.state", { state: "listening" });
    } else if (type === "input_audio_buffer.speech_stopped") {
      if (!this.#engaged) return;
      this.#inputActive = false;
      this.#options.emit("voice.state", { state: "thinking" });
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
        if (this.#responsePending) {
          this.#responsePending = false;
          this.#requestResponse();
        } else {
          this.#options.emit("voice.state", { state: this.#engaged ? "listening" : "idle" });
        }
        return;
      }
      this.#responseActive = false;
      this.#responsePending = false;
      this.#suppressAudio = !this.#engaged;
      this.#cancellationRequested = false;
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
      this.#requestResponse();
      return;
    }
    if (calls.length === 0) {
      this.#toolChainDepth = 0;
      this.#options.emit("voice.state", { state: "idle" });
      return;
    }
    this.#toolChainDepth += 1;

    for (const call of calls) {
      let result: unknown;
      try {
        const args = JSON.parse(call.arguments) as unknown;
        result = await this.#executeTool(call.name, args);
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
      this.#options.emit("voice.state", { state: "idle" });
      return;
    }
    if (calls.every((call) => call.name === "wait_for_user")) {
      this.#toolChainDepth = 0;
      if (this.#responsePending) {
        this.#requestResponse();
      } else {
        this.#options.emit("voice.state", { state: "idle" });
      }
      return;
    }
    if (this.#toolChainDepth >= 4) {
      this.#toolChainDepth = 0;
      this.#options.emit("voice.error", {
        error: "Voice tool chain stopped after four consecutive tool rounds",
      });
      this.#options.emit("voice.state", { state: "idle" });
      return;
    }
    this.#requestResponse();
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

  async #executeTool(name: string, input: unknown): Promise<unknown> {
    if (!isObject(input)) throw new Error(`${name} arguments must be an object`);
    switch (name) {
      case "wait_for_user":
        assertOnlyKeys(input, [], name);
        return { status: "waiting" };
      case "get_workspace": {
        assertOnlyKeys(input, ["view"], name);
        const view = input["view"];
        if (!(view === "active" || view === "available")) throw new Error("view must be active or available");
        const active = this.#options.getWorkspace();
        return view === "active"
          ? { repositoryId: active, path: active }
          : { repositories: [...new Set(this.#options.getAvailableWorkspaces?.() ?? [active])] };
      }
      case "list_coding_profiles":
        assertOnlyKeys(input, [], name);
        return { profiles: [...new Set(this.#options.getCodingProfiles?.() ?? ["auto", "primary", "fast"])] };
      case "capture_editor_context": {
        assertOnlyKeys(input, ["kinds"], name);
        const kinds = requireStringArray(input["kinds"], "kinds", false);
        const allowedKinds = new Set<ContextKind>(["active_file", "selection", "diagnostics", "terminal_excerpt"]);
        if (new Set(kinds).size !== kinds.length || kinds.some((kind) => !allowedKinds.has(kind as ContextKind))) {
          throw new Error("kinds must contain unique supported editor context kinds");
        }
        if (!this.#options.captureEditorContext) {
          return {
            status: "rejected",
            code: "editor_context_unavailable",
            explanation: "No VS Code editor context bridge is available",
          };
        }
        try {
          const result = await this.#options.captureEditorContext(kinds as ContextKind[]);
          return {
            status: "accepted",
            artifactIds: result.artifacts.map((artifact) => artifact.id),
            artifacts: result.artifacts,
            errors: result.errors,
          };
        } catch (error) {
          return {
            status: "rejected",
            code: /timed out/i.test(error instanceof Error ? error.message : String(error))
              ? "editor_context_timeout"
              : "editor_context_unavailable",
            explanation: error instanceof Error ? error.message : String(error),
          };
        }
      }
      case "submit_task": {
        assertOnlyKeys(
          input,
          ["repositoryId", "objective", "acceptanceCriteria", "constraints", "attachmentIds", "codingProfileId"],
          name,
        );
        const repositoryId = requireString(input["repositoryId"], "repositoryId");
        const objective = requireString(input["objective"], "objective");
        const acceptanceCriteria = requireStringArray(input["acceptanceCriteria"], "acceptanceCriteria", false);
        const constraints = requireStringArray(input["constraints"], "constraints", true);
        const attachmentIds = requireStringArray(input["attachmentIds"], "attachmentIds", true);
        const codingProfileId = requireNullableString(input["codingProfileId"], "codingProfileId");
        const result = await this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "task.submit",
          actor: "voice",
          expectedRevision: null,
          payload: { repositoryId, objective, acceptanceCriteria, constraints, attachmentIds, codingProfileId },
        });
        if (result.status === "accepted") {
          for (const id of attachmentIds) this.#pendingContext.delete(id);
          if (attachmentIds.length > 0) {
            this.#options.emit("context.consumed", { ids: attachmentIds, taskId: result.taskId ?? null });
          }
        }
        return result;
      }
      case "get_task_status": {
        assertOnlyKeys(input, ["taskId", "view"], name);
        const view = input["view"];
        const views = new Set(["brief", "current_step", "plan", "queue", "changes", "verification", "decisions"]);
        if (typeof view !== "string" || !views.has(view)) throw new Error("get_task_status view is invalid");
        const task = this.#resolveTask(input["taskId"]);
        if (!task) return { status: "idle", queue: this.#options.getSnapshot().queue };
        return this.#status(task, view);
      }
      case "get_task_artifact": {
        assertOnlyKeys(input, ["taskId", "artifactId", "view"], name);
        const taskId = requireString(input["taskId"], "taskId");
        const artifactId = requireString(input["artifactId"], "artifactId");
        const view = input["view"];
        if (!(view === "summary" || view === "bounded_excerpt")) {
          throw new Error("view must be summary or bounded_excerpt");
        }
        const artifact = this.#options.getTaskArtifact?.(taskId, artifactId);
        if (!artifact) {
          return {
            status: "rejected",
            code: "artifact_not_found",
            explanation: "The artifact does not exist or does not belong to this task",
          };
        }
        const summary = {
          id: artifact.id,
          taskId: artifact.taskId,
          runId: artifact.runId,
          toolName: artifact.toolName,
          kind: artifact.kind,
          summary: artifact.summary.slice(0, 2_000),
          successful: artifact.successful,
          createdAt: artifact.createdAt,
        };
        if (view === "summary") return summary;
        const resultExcerpt = typeof artifact.payload["resultExcerpt"] === "string"
          ? artifact.payload["resultExcerpt"].slice(0, 6_000)
          : "";
        const changedFiles = Array.isArray(artifact.payload["changedFiles"])
          ? artifact.payload["changedFiles"].filter((value): value is string => typeof value === "string").slice(0, 100)
          : [];
        return { ...summary, excerpt: resultExcerpt, changedFiles, truncated: resultExcerpt.length === 6_000 };
      }
      case "answer_task_question": {
        assertOnlyKeys(input, ["requestId", "answer"], name);
        const requestId = requireString(input["requestId"], "requestId");
        const answer = requireString(input["answer"], "answer");
        const snapshot = this.#options.getSnapshot();
        const question = snapshot.questions?.find((candidate) => candidate.id === requestId);
        if (!question || question.state !== "open") {
          return {
            status: "rejected",
            code: "question_not_open",
            explanation: "The question request is stale or no longer open",
          };
        }
        const task = snapshot.tasks.find((candidate) => candidate.id === question.taskId);
        if (!task || task.revision !== question.taskRevision) {
          return {
            status: "conflict",
            currentRevision: task?.revision ?? question.taskRevision,
            explanation: "The question belongs to an older task revision",
          };
        }
        return this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "task.answerQuestion",
          actor: "voice",
          expectedRevision: task.revision,
          payload: { taskId: task.id, questionId: question.id, answer },
        });
      }
      case "ask_coder": {
        assertOnlyKeys(input, ["taskId", "question"], name);
        const taskId = requireString(input["taskId"], "taskId");
        const question = requireString(input["question"], "question");
        if (!this.#options.getSnapshot().tasks.some((task) => task.id === taskId)) {
          return { status: "rejected", code: "task_not_found", explanation: "No matching task exists" };
        }
        if (!this.#options.askCoder || !(await this.#options.askCoder(taskId, question))) {
          return {
            status: "rejected",
            code: "coder_unavailable",
            explanation: "The live coding agent is unavailable for this task",
          };
        }
        return { status: "accepted", eventId: Bun.randomUUIDv7(), taskId };
      }
      case "propose_task_change":
        assertOnlyKeys(input, ["taskId", "change", "desiredOutcome", "addedConstraints"], name);
        return this.#proposeTaskChange(input);
      case "control_task": {
        assertOnlyKeys(input, ["taskId", "action"], name);
        const task = this.#resolveTask(requireString(input["taskId"], "taskId"));
        if (!task) return { status: "rejected", code: "task_not_found", explanation: "No matching task exists" };
        const action = input["action"];
        if (!(action === "pause" || action === "resume" || action === "cancel")) {
          throw new Error("action must be pause, resume, or cancel");
        }
        const type = action === "pause" ? "task.requestPause" : action === "resume" ? "task.resume" : "task.cancel";
        return this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type,
          actor: "voice",
          expectedRevision: task.revision,
          payload:
            action === "pause"
              ? { taskId: task.id, reason: "User requested a voice pause" }
              : action === "cancel"
                ? { taskId: task.id, reason: "User cancelled by voice" }
                : { taskId: task.id },
        });
      }
      case "manage_queue": {
        assertOnlyKeys(input, ["taskId", "operation", "anchorTaskId"], name);
        const taskId = requireString(input["taskId"], "taskId");
        const operation = input["operation"];
        if (!["move_first", "move_last", "move_before", "move_after"].includes(String(operation))) {
          throw new Error("manage_queue operation is invalid");
        }
        const anchorTaskId = requireNullableString(input["anchorTaskId"], "anchorTaskId");
        return this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "queue.move",
          actor: "voice",
          expectedRevision: null,
          payload: { taskId, operation, anchorTaskId },
        });
      }
      case "resolve_confirmation": {
        assertOnlyKeys(input, ["confirmationId", "decision"], name);
        const confirmationId = requireString(input["confirmationId"], "confirmationId");
        const decision = input["decision"];
        if (!(decision === "approve" || decision === "reject")) throw new Error("decision must be approve or reject");
        const snapshot = this.#options.getSnapshot();
        const confirmation = snapshot.confirmations.find((candidate) => candidate.id === confirmationId);
        if (!confirmation || confirmation.state !== "pending") {
          return {
            status: "rejected",
            code: "confirmation_not_pending",
            explanation: "No matching pending confirmation exists",
          };
        }
        const task = snapshot.tasks.find((candidate) => candidate.id === confirmation.taskId);
        if (!task) return { status: "rejected", code: "task_not_found", explanation: "The confirmation task no longer exists" };
        return this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "approval.resolve",
          actor: "voice",
          expectedRevision: task.revision,
          payload: { confirmationId, decision },
        });
      }
      case "remember_fact": {
        assertOnlyKeys(input, ["scope", "projectId", "fact"], name);
        const scope = input["scope"];
        if (!(scope === "global" || scope === "project")) throw new Error("scope must be global or project");
        const projectId = requireNullableString(input["projectId"], "projectId");
        if ((scope === "global" && projectId !== null) || (scope === "project" && projectId !== this.#options.getWorkspace())) {
          return {
            status: "rejected",
            code: "memory_scope_mismatch",
            explanation: "Global facts require projectId null; project facts require the active repository ID",
          };
        }
        if (!this.#options.rememberFact) {
          return { status: "rejected", code: "memory_unavailable", explanation: "Durable memory is unavailable" };
        }
        const memory = this.#options.rememberFact(scope, projectId, requireString(input["fact"], "fact"));
        return { status: "accepted", eventId: memory.id, memoryId: memory.id, scope: memory.scope, projectId: memory.projectId };
      }
      case "forget_fact": {
        assertOnlyKeys(input, ["memoryId"], name);
        const memoryId = requireString(input["memoryId"], "memoryId");
        if (!this.#options.forgetFact) {
          return { status: "rejected", code: "memory_unavailable", explanation: "Durable memory is unavailable" };
        }
        if (!this.#options.forgetFact(memoryId)) {
          return {
            status: "rejected",
            code: "memory_not_found",
            explanation: "The memory does not exist or is outside the active project scope",
          };
        }
        return { status: "accepted", eventId: Bun.randomUUIDv7(), memoryId };
      }
      case "inspect_workspace": {
        assertOnlyKeys(input, ["question", "deliverable"], name);
        const question = requireString(input["question"], "question");
        const deliverable = requireString(input["deliverable"], "deliverable");
        return this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "task.submit",
          actor: "voice",
          expectedRevision: null,
          payload: {
            repositoryId: this.#options.getWorkspace(),
            objective: `Inspect the current repository to answer: ${question}`,
            acceptanceCriteria: [
              deliverable,
              "Use current workspace evidence and identify exact commits, paths, symbols, or command output where relevant.",
              "Clearly distinguish observed facts from inference.",
            ],
            constraints: [
              "Read-only inspection; do not modify workspace files.",
              "Use the coding agent's repository tools rather than relying on the voice model's memory.",
            ],
            attachmentIds: [],
            codingProfileId: "fast",
          },
        });
      }
      case "research_web": {
        assertOnlyKeys(input, ["query", "deliverable"], name);
        const query = requireString(input["query"], "query");
        const deliverable = requireString(input["deliverable"], "deliverable");
        const objective = `Research the web for: ${query}`;
        const duplicate = this.#options.getSnapshot().tasks.find((task) =>
          !["completed", "failed", "cancelled"].includes(task.state) &&
          task.repositoryId === this.#options.getWorkspace() &&
          task.spec.objective.trim().toLocaleLowerCase() === objective.trim().toLocaleLowerCase()
        );
        if (duplicate) {
          return {
            status: "accepted",
            taskId: duplicate.id,
            state: duplicate.state,
            deduplicated: true,
          };
        }
        return this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "task.submit",
          actor: "voice",
          expectedRevision: null,
          payload: {
            repositoryId: this.#options.getWorkspace(),
            objective,
            acceptanceCriteria: [
              deliverable,
              "Use current authoritative sources and include their URLs.",
              "Clearly distinguish confirmed facts from inference.",
            ],
            constraints: [
              "Research only; do not modify workspace files.",
              "Use the coding agent's web_search and read tools rather than relying on model memory.",
              "Return as soon as the requested facts and source URLs are verified; do not broaden the research scope.",
            ],
            attachmentIds: [],
            codingProfileId: "fast",
          },
        });
      }
      case "set_overlay": {
        assertOnlyKeys(input, ["action"], name);
        const action = requireString(input["action"], "action");
        if (!(action === "expand" || action === "collapse")) throw new Error("action must be expand or collapse");
        const expanded = action === "expand";
        this.#options.emit("ui.overlay", { expanded });
        return { status: "ok", expanded };
      }
      case "control_computer": {
        const request = parseComputerControlRequest(input);
        if (!this.#options.controlComputer) {
          return {
            status: "rejected",
            action: request.action,
            code: "computer_control_unavailable",
            explanation: "Computer control is unavailable in this Mamachi runtime",
          };
        }
        if (this.#computerControlNeedsConfirmation(request.action)) {
          this.#clearPendingComputerControls("superseded");
          const requestId = Bun.randomUUIDv7();
          const expiresAt = Date.now() + 120_000;
          const timeout = setTimeout(() => {
            const expired = this.#pendingComputerControls.get(requestId);
            if (!expired) return;
            this.#pendingComputerControls.delete(requestId);
            this.#options.emit("computer.confirmation_expired", {
              requestId,
              action: expired.request.action,
            });
          }, 120_000);
          this.#pendingComputerControls.set(requestId, { request, expiresAt, timeout });
          const result = {
            status: "confirmation_required",
            requestId,
            action: request.action,
            summary: this.#computerControlSummary(request),
          };
          this.#options.emit("computer.confirmation_required", result);
          return result;
        }
        return this.#runComputerControl(request);
      }
      case "resolve_computer_control": {
        assertOnlyKeys(input, ["requestId", "decision"], name);
        const requestId = requireString(input["requestId"], "requestId");
        const decision = requireString(input["decision"], "decision");
        if (decision !== "approve" && decision !== "reject") {
          throw new Error("decision must be approve or reject");
        }
        const pending = this.#pendingComputerControls.get(requestId);
        this.#pendingComputerControls.delete(requestId);
        if (pending) clearTimeout(pending.timeout);
        if (!pending || pending.expiresAt < Date.now()) {
          return {
            status: "rejected",
            code: "computer_confirmation_expired",
            explanation: "That computer-control request is no longer pending",
          };
        }
        this.#options.emit("computer.confirmation_resolved", {
          requestId,
          action: pending.request.action,
          decision,
        });
        if (decision === "reject") {
          return {
            status: "rejected",
            action: pending.request.action,
            code: "user_rejected",
            explanation: "The user rejected the computer action",
          };
        }
        return this.#runComputerControl(pending.request);
      }
      case "mute_mamachi":
        assertOnlyKeys(input, [], name);
        this.#options.emit("ui.mute", {});
        return { status: "ok", muted: true };
      default:
        throw new Error(`Unknown voice tool: ${name}`);
    }
  }

  #clearPendingComputerControls(reason: string): void {
    if (this.#pendingComputerControls.size === 0) return;
    for (const pending of this.#pendingComputerControls.values()) clearTimeout(pending.timeout);
    this.#pendingComputerControls.clear();
    this.#options.emit("computer.confirmation_cleared", { reason });
  }

  #computerControlNeedsConfirmation(action: ComputerAction): boolean {
    const mode = this.#options.getComputerConfirmationMode?.() ?? "sensitive";
    return mode === "always" || (mode === "sensitive" && sensitiveComputerActions.includes(action));
  }

  #computerControlSummary(request: ComputerControlRequest): string {
    const target =
      request.application ??
      request.url ??
      request.path ??
      (request.action === "run_shell_command"
        ? "a shell command"
        : request.action === "run_applescript"
          ? "an AppleScript"
          : "this Mac");
    return `${request.action} on ${target}`.slice(0, 500);
  }

  async #runComputerControl(request: ComputerControlRequest): Promise<ComputerControlResult> {
    if (!this.#options.controlComputer) {
      return {
        status: "rejected",
        action: request.action,
        code: "computer_control_unavailable",
        explanation: "Computer control is unavailable in this Mamachi runtime",
      };
    }
    const result = await this.#options.controlComputer(request);
    this.#options.emit("computer.control", result);
    return result;
  }

  async #proposeTaskChange(input: Record<string, unknown>): Promise<unknown> {
    let task = this.#resolveTask(requireString(input["taskId"], "taskId"));
    if (!task) return { status: "rejected", code: "task_not_found", explanation: "No matching task exists" };
    const change = requireString(input["change"], "change");
    const desiredOutcome = requireNullableString(input["desiredOutcome"], "desiredOutcome");
    const addedConstraints = requireStringArray(input["addedConstraints"], "addedConstraints", true);

    if (task.state === "running") {
      const pause = await this.#options.executeCommand({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: task.revision,
        payload: { taskId: task.id, reason: "Applying a proposed voice task change at a safe boundary" },
      });
      if (pause.status !== "accepted") return pause;
    }
    if (task.state === "running" || task.state === "pause_requested") {
      task = await this.#waitForTaskState(task.id, "paused", 60_000);
    }
    if (!(task.state === "paused" || task.state === "awaiting_user")) {
      return {
        status: "rejected",
        code: "invalid_state",
        explanation: `Task cannot be revised from ${task.state}`,
      };
    }

    const changeConstraint = `Requested change: ${change}`;
    const constraints = [...new Set([...task.spec.constraints, changeConstraint, ...addedConstraints])];
    const acceptanceCriteria = desiredOutcome
      ? [...new Set([...task.spec.acceptanceCriteria, desiredOutcome])]
      : [...task.spec.acceptanceCriteria];
    const revised = await this.#options.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.revise",
      actor: "voice",
      expectedRevision: task.revision,
      payload: {
        taskId: task.id,
        spec: {
          ...task.spec,
          acceptanceCriteria,
          constraints,
        },
      },
    });
    if (revised.status !== "accepted") return revised;

    const latest = this.#options.getSnapshot().tasks.find((candidate) => candidate.id === task.id);
    if (!latest) throw new Error("Revised task disappeared");
    const resumed = await this.#options.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.resume",
      actor: "voice",
      expectedRevision: latest.revision,
      payload: { taskId: latest.id },
    });
    return resumed.status === "accepted" ? { ...resumed, revision: latest.revision } : resumed;
  }

  async #waitForTaskState(taskId: string, state: TaskRecord["state"], timeoutMs: number): Promise<TaskRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.#options.getSnapshot().tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("Task disappeared while waiting for a safe boundary");
      if (task.state === state) return task;
      if (["completed", "failed", "cancelled"].includes(task.state)) return task;
      await Bun.sleep(50);
    }
    throw new Error("Timed out waiting for the coding agent to reach a safe pause boundary");
  }

  #resolveTask(taskId: unknown): TaskRecord | undefined {
    const snapshot = this.#options.getSnapshot();
    if (typeof taskId === "string") return snapshot.tasks.find((task) => task.id === taskId);
    if (taskId !== null) throw new Error("taskId must be a task ID or null");
    if (snapshot.activeTaskId) return snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
    return snapshot.tasks.at(-1);
  }

  #status(task: TaskRecord, view: string): unknown {
    const snapshot = this.#options.getSnapshot();
    const facts = this.#options.getTaskFacts?.(task.id) ?? null;
    const brief = {
      id: task.id,
      state: task.state,
      revision: task.revision,
      objective: task.spec.objective,
      repositoryId: task.repositoryId,
      summary: task.terminalSummary,
      queuePosition: snapshot.queue.indexOf(task.id),
    };
    if (view === "brief") return brief;
    if (view === "current_step") {
      return { ...brief, currentStep: facts?.currentStep ?? null, recentActivity: this.#recentActivity.get(task.id) ?? null };
    }
    if (view === "plan") {
      return {
        ...brief,
        acceptanceCriteria: task.spec.acceptanceCriteria,
        constraints: task.spec.constraints,
        codingProfileId: task.spec.codingProfileId,
      };
    }
    if (view === "queue") {
      return {
        ...brief,
        queue: snapshot.queue.map((taskId, position) => {
          const queued = snapshot.tasks.find((candidate) => candidate.id === taskId);
          return { taskId, position, objective: queued?.spec.objective ?? null };
        }),
      };
    }
    if (view === "changes") {
      return { ...brief, changedFiles: facts?.changedFiles ?? [], recentActivity: facts?.recentActivity ?? [] };
    }
    if (view === "verification") {
      return {
        ...brief,
        verificationState: facts?.verificationState ?? "pending",
        verificationSummaries: facts?.verificationSummaries ?? [],
      };
    }
    return {
      ...brief,
      specHistory: task.specHistory,
      pendingQuestion: snapshot.questions?.find((question) => question.taskId === task.id && question.state === "open") ?? null,
      pendingConfirmations: snapshot.confirmations.filter(
        (confirmation) => confirmation.taskId === task.id && confirmation.state === "pending",
      ),
    };
  }

  #requestResponse(): void {
    if (!this.#engaged && this.#responseMode === "voice") {
      this.#responsePending = false;
      return;
    }
    if (this.#responseActive || this.#inputActive) {
      this.#responsePending = true;
      return;
    }
    this.#responsePending = false;
    this.#responseActive = true;
    this.#suppressAudio = false;
    this.#options.emit("voice.state", { state: "thinking" });
    this.#send({ type: "response.create" });
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
