import WebSocket, { type RawData } from "ws";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import type { ControllerSnapshot, TaskRecord } from "./domain.ts";
import type { CapturedContext } from "./artifact-store.ts";
export type RealtimeResponseMode = "voice" | "text";

interface RealtimeBridgeOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  endpoint?: string;
  getWorkspace: () => string;
  getSnapshot: () => ControllerSnapshot;
  executeCommand: (command: unknown) => Promise<ActionResult>;
  emit: (type: string, payload: unknown) => void;
  emitAudio: (pcm: Uint8Array) => void;
}

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
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

export class RealtimeBridge {
  readonly #options: RealtimeBridgeOptions;
  readonly #model: string;
  readonly #voice: string;
  readonly #endpoint: string;
  readonly #recentActivity = new Map<string, { type: string; summary: string; at: string }>();
  readonly #pendingContext = new Map<string, CapturedContext>();
  #apiKey: string | undefined;
  #socket: WebSocket | null = null;
  #manualClose = false;
  #responseActive = false;
  #responsePending = false;
  #inputActive = false;
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
  }

  async connect(apiKey?: string): Promise<void> {
    if (apiKey) this.#apiKey = apiKey;
    if (!this.#apiKey) throw new Error("OpenAI Realtime requires an API key");
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#socket) await this.disconnect();

    this.#manualClose = false;
    this.#responseActive = false;
    this.#responsePending = false;
    this.#inputActive = false;
    this.#suppressAudio = false;
    this.#cancellationRequested = false;
    this.#toolChainDepth = 0;
    this.#options.emit("voice.state", { state: "connecting" });
    const separator = this.#endpoint.includes("?") ? "&" : "?";
    const socket = new WebSocket(`${this.#endpoint}${separator}model=${encodeURIComponent(this.#model)}`, {
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
    });
    this.#socket = socket;
    socket.on("close", () => {
      if (this.#socket === socket) this.#socket = null;
      this.#responseActive = false;
      this.#responsePending = false;
      this.#inputActive = false;
      this.#suppressAudio = false;
      this.#cancellationRequested = false;
      if (!this.#manualClose) {
        this.#options.emit("voice.state", { state: "disconnected", reason: "provider_connection_closed" });
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
    for (const context of this.#pendingContext.values()) this.#injectContext(context);
  }

  async disconnect(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    this.#manualClose = true;
    this.#responseActive = false;
    this.#responsePending = false;
    this.#inputActive = false;
    this.#suppressAudio = false;
    this.#cancellationRequested = false;
    this.#toolChainDepth = 0;
    this.#socket = null;
    if (socket.readyState === WebSocket.CLOSED) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timeout = setTimeout(resolve, 2_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close(1000, "Voice disengaged");
    await promise;
    this.#options.emit("voice.state", { state: "disconnected" });
  }

  appendAudio(pcm: Uint8Array): void {
    if (pcm.byteLength === 0 || this.#socket?.readyState !== WebSocket.OPEN) return;
    const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
    this.#send({ type: "input_audio_buffer.append", audio });
  }

  interrupt(): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#toolChainDepth = 0;
    this.#suppressAudio = true;
    if (this.#responseActive) {
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


  handleTaskEvents(events: readonly DomainEvent[]): void {
    if (events.length === 0 || this.#socket?.readyState !== WebSocket.OPEN) return;
    const relevant = events.filter((event) =>
      [
        "task.started",
        "task.pauseRequested",
        "task.paused",
        "task.awaitingUser",
        "task.specRevised",
        "task.resumed",
        "task.completed",
        "task.failed",
        "task.cancelled",
      ].includes(event.type),
    );
    if (relevant.length === 0) return;
    const announce = relevant.some((event) =>
      event.type === "task.awaitingUser" || event.type === "task.completed" || event.type === "task.failed",
    );
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
                events: relevant.map((event) => ({
                  type: event.type,
                  taskId: event.taskId ?? null,
                  payload: event.payload,
                })),
              }),
            ].join("\n"),
          },
        ],
      },
    });
    if (announce) this.#requestResponse();
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
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
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

# Course correction
A clarification or changed requirement must use revise_task. Before calling it, summarize the revised objective and obtain explicit confirmation. The tool safely pauses, versions the task, and resumes it. Never describe a revision as applied before the tool succeeds.

# Control
Use control_task only for an explicit pause, resume, or cancel request. A barge-in does not imply cancellation.

# Style
Default to one short spoken sentence of at most 20 words. Do not restate the request or narrate your reasoning. Ask one brief question only when required. Task status gives only outcome, current step, or blocker. Expand only when the user explicitly asks for detail. Never give progress percentages or time estimates. Mirror the user's language and preserve technical identifiers verbatim.

# Audio
If audio is unclear, ask briefly rather than guessing. If audio is silence, media, background speech, or not addressed to you, call wait_for_user and remain silent.

# Current workspace
${this.#options.getWorkspace()}
`;
  }

  #tools(): unknown[] {
    return [
      {
        type: "function",
        name: "submit_task",
        description: "Start or queue a sufficiently specified coding task in the selected workspace.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            objective: { type: "string", minLength: 1 },
            acceptanceCriteria: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            constraints: { type: "array", items: { type: "string", minLength: 1 } },
          },
          required: ["objective", "acceptanceCriteria", "constraints"],
        },
      },
      {
        type: "function",
        name: "get_task_status",
        description: "Read authoritative status for the active or specified task.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: ["string", "null"] },
          },
          required: ["taskId"],
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
            taskId: { type: ["string", "null"] },
            action: { type: "string", enum: ["pause", "resume", "cancel"] },
          },
          required: ["taskId", "action"],
        },
      },
      {
        type: "function",
        name: "revise_task",
        description: "After explicit confirmation, safely pause the active task, apply a new specification revision, and resume it.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: ["string", "null"] },
            objective: { type: "string", minLength: 1 },
            acceptanceCriteria: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            constraints: { type: "array", items: { type: "string", minLength: 1 } },
          },
          required: ["taskId", "objective", "acceptanceCriteria", "constraints"],
        },
      },
      {
        type: "function",
        name: "inspect_workspace",
        description: "Delegate a read-only question about current repository state to the coding agent. Always use for commits, branches, files, code, tests, diagnostics, dependencies, or logs.",
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
        name: "get_workspace",
        description: "Return the selected workspace path.",
        parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
      },
      {
        type: "function",
        name: "wait_for_user",
        description: "End the turn silently when audio is not addressed to Mamachi or needs no response.",
        parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
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
      this.#inputActive = true;
      this.#toolChainDepth = 0;
      if (this.#responseActive) this.#suppressAudio = true;
      this.#options.emit("voice.interrupt", {});
      this.#options.emit("voice.state", { state: "listening" });
    } else if (type === "input_audio_buffer.speech_stopped") {
      this.#inputActive = false;
      this.#options.emit("voice.state", { state: "thinking" });
      this.#requestResponse();
    } else if (type === "conversation.item.input_audio_transcription.delta") {
      if (typeof event["delta"] === "string") {
        this.#options.emit("voice.transcript.user_delta", { text: event["delta"] });
      }
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      if (typeof event["transcript"] === "string") {
        this.#options.emit("voice.transcript.user", { text: event["transcript"] });
      }
    } else if (type === "response.output_audio.delta") {
      if (typeof event["delta"] === "string" && !this.#suppressAudio) {
        const audio = Buffer.from(event["delta"], "base64");
        this.#options.emitAudio(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
        this.#options.emit("voice.state", { state: "speaking" });
      }
    } else if (type === "response.output_audio_transcript.delta") {
      if (typeof event["delta"] === "string") {
        this.#options.emit("voice.transcript.assistant_delta", { text: event["delta"] });
      }
    } else if (type === "response.output_audio_transcript.done") {
      if (typeof event["transcript"] === "string") {
        this.#options.emit("voice.transcript.assistant", { text: event["transcript"] });
      }
    } else if (type === "response.output_text.delta") {
      if (typeof event["delta"] === "string") {
        this.#options.emit("voice.transcript.assistant_delta", { text: event["delta"] });
      }
    } else if (type === "response.output_text.done") {
      if (typeof event["text"] === "string") {
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
          this.#options.emit("voice.state", { state: "listening" });
        }
        return;
      }
      this.#responseActive = false;
      this.#responsePending = false;
      this.#suppressAudio = false;
      this.#cancellationRequested = false;
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

  async #executeTool(name: string, input: unknown): Promise<unknown> {
    if (!isObject(input)) throw new Error(`${name} arguments must be an object`);
    switch (name) {
      case "submit_task": {
        const objective = requireString(input["objective"], "objective");
        const acceptanceCriteria = requireStringArray(input["acceptanceCriteria"], "acceptanceCriteria", false);
        const constraints = requireStringArray(input["constraints"], "constraints", true);
        if (/\b(deploy|publish|release|delete repository|force[- ]push|reset --hard)\b/i.test(objective)) {
          return {
            status: "rejected",
            code: "visual_approval_required",
            explanation: "This high-impact request requires a visual approval card",
          };
        }
        const attachmentIds = [...this.#pendingContext.keys()];
        const result = await this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "task.submit",
          actor: "voice",
          expectedRevision: null,
          payload: {
            repositoryId: this.#options.getWorkspace(),
            objective,
            acceptanceCriteria,
            constraints,
            attachmentIds,
            codingProfileId: null,
          },
        });
        if (result.status === "accepted") {
          for (const id of attachmentIds) this.#pendingContext.delete(id);
          if (attachmentIds.length > 0) {
            this.#options.emit("context.consumed", {
              ids: attachmentIds,
              taskId: result.taskId ?? null,
            });
          }
        }
        return { ...result, attachmentIds };
      }
      case "inspect_workspace": {
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
        const query = requireString(input["query"], "query");
        const deliverable = requireString(input["deliverable"], "deliverable");
        return this.#options.executeCommand({
          id: Bun.randomUUIDv7(),
          type: "task.submit",
          actor: "voice",
          expectedRevision: null,
          payload: {
            repositoryId: this.#options.getWorkspace(),
            objective: `Research the web for: ${query}`,
            acceptanceCriteria: [
              deliverable,
              "Use current authoritative sources and include their URLs.",
              "Clearly distinguish confirmed facts from inference.",
            ],
            constraints: [
              "Research only; do not modify workspace files.",
              "Use the coding agent's web_search and read tools rather than relying on model memory.",
            ],
            attachmentIds: [],
            codingProfileId: "fast",
          },
        });
      }
      case "get_task_status": {
        const task = this.#resolveTask(input["taskId"]);
        if (!task) return { status: "idle", queue: this.#options.getSnapshot().queue };
        return this.#status(task);
      }
      case "control_task": {
        const task = this.#resolveTask(input["taskId"]);
        if (!task) throw new Error("No matching task exists");
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
      case "revise_task":
        return this.#reviseTask(input);
      case "get_workspace":
        return { workspace: this.#options.getWorkspace() };
      case "wait_for_user":
        return { status: "waiting" };
      default:
        throw new Error(`Unknown voice tool: ${name}`);
    }
  }

  async #reviseTask(input: Record<string, unknown>): Promise<unknown> {
    let task = this.#resolveTask(input["taskId"]);
    if (!task) throw new Error("No matching task exists");
    const objective = requireString(input["objective"], "objective");
    const acceptanceCriteria = requireStringArray(input["acceptanceCriteria"], "acceptanceCriteria", false);
    const constraints = requireStringArray(input["constraints"], "constraints", true);

    if (task.state === "running") {
      const pause = await this.#options.executeCommand({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: task.revision,
        payload: { taskId: task.id, reason: "Applying a confirmed voice amendment" },
      });
      if (pause.status !== "accepted") return pause;
    }
    if (task.state === "running" || task.state === "pause_requested") {
      task = await this.#waitForTaskState(task.id, "paused", 60_000);
    }
    if (!(task.state === "paused" || task.state === "awaiting_user")) {
      throw new Error(`Task cannot be revised from ${task.state}`);
    }

    const revised = await this.#options.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.revise",
      actor: "voice",
      expectedRevision: task.revision,
      payload: {
        taskId: task.id,
        spec: {
          ...task.spec,
          objective,
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
    return {
      status: resumed.status,
      taskId: latest.id,
      revision: latest.revision,
      resumed,
    };
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

  #status(task: TaskRecord): unknown {
    return {
      id: task.id,
      state: task.state,
      revision: task.revision,
      objective: task.spec.objective,
      repository: task.repositoryId,
      runs: task.runIds.length,
      summary: task.terminalSummary,
      recentActivity: this.#recentActivity.get(task.id) ?? null,
      queuePosition: this.#options.getSnapshot().queue.indexOf(task.id),
    };
  }

  #requestResponse(): void {
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
