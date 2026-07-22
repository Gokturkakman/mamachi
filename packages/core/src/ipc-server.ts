import { timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { parseCommand, type ActionResult, type DomainEvent } from "@mamachi/protocol";
import { TaskController } from "./controller.ts";
import { EventStore } from "./event-store.ts";
import { ArtifactStore, type CapturedContext, type ContextKind } from "./artifact-store.ts";
import { parseRuntimeSettings, type RuntimeSettings } from "./model-router.ts";

interface ClientData {
  id: string;
}

type ClientSocket = ServerWebSocket<ClientData>;

interface RequestEnvelope {
  version: 1;
  id: string;
  type:
    | "state.get"
    | "workspace.select"
    | "workspace.focus"
    | "context.capture"
    | "command.execute"
    | "settings.update"
    | "voice.connect"
    | "voice.disconnect"
    | "voice.interrupt"
    | "voice.text"
    | "voice.mode";
  payload: unknown;
}

export interface DaemonHooks {
  onAudioInput?: (pcm: Uint8Array) => void;
  onTaskEvents?: (events: DomainEvent[]) => void | Promise<void>;
  onContextCaptured?: (context: CapturedContext) => void;
  onSettingsUpdate?: (settings: RuntimeSettings) => void;
  onVoiceConnect?: (apiKey?: string) => void | Promise<void>;
  onVoiceDisconnect?: () => void | Promise<void>;
  onVoiceInterrupt?: () => void;
  onVoiceText?: (text: string) => void | Promise<void>;
  onVoiceMode?: (mode: "voice" | "text") => void;
}

export interface IpcServerOptions {
  token: string;
  port?: number;
  hostname?: string;
  databasePath?: string;
  initialWorkspace?: string;
  hooks?: DaemonHooks;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseRequest(input: unknown): RequestEnvelope {
  if (!isObject(input) || !hasOnlyKeys(input, ["version", "id", "type", "payload"])) {
    throw new Error("Invalid IPC request envelope");
  }
  if (input["version"] !== 1 || typeof input["id"] !== "string" || typeof input["type"] !== "string") {
    throw new Error("Invalid IPC request fields");
  }
  const supported = new Set([
    "state.get",
    "workspace.select",
    "workspace.focus",
    "context.capture",
    "command.execute",
    "settings.update",
    "voice.connect",
    "voice.disconnect",
    "voice.interrupt",
    "voice.text",
    "voice.mode",
  ]);
  if (!supported.has(input["type"])) throw new Error(`Unsupported IPC request type: ${input["type"]}`);
  return input as unknown as RequestEnvelope;
}

function isAuthorized(request: Request, token: string): boolean {
  const actual = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class MamachiIpcServer {
  readonly #token: string;
  readonly #controller: TaskController;
  readonly #store: EventStore;
  readonly #artifacts: ArtifactStore;
  readonly #hooks: DaemonHooks;
  readonly #clients = new Set<ClientSocket>();
  readonly #server: Server<ClientData>;
  #workspace: string;

  constructor(options: IpcServerOptions) {
    this.#token = options.token;
    this.#hooks = options.hooks ?? {};
    this.#workspace = realpathSync(options.initialWorkspace ?? process.cwd());
    const databasePath = options.databasePath ?? ":memory:";
    this.#store = new EventStore(databasePath);
    this.#artifacts = new ArtifactStore(databasePath);
    this.#controller = new TaskController(this.#store);

    this.#server = Bun.serve<ClientData>({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 0,
      fetch: (request, server) => this.#handleUpgrade(request, server),
      websocket: {
        open: (socket) => {
          this.#clients.add(socket);
          this.#send(socket, "server.ready", {
            clientId: socket.data.id,
            workspace: this.#workspace,
            snapshot: this.#controller.snapshot(),
          });
        },
        message: (socket, message) => {
          if (typeof message !== "string") {
            const pcm = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
            this.#hooks.onAudioInput?.(pcm);
            return;
          }
          void this.#handleMessage(socket, message);
        },
        close: (socket) => {
          this.#clients.delete(socket);
        },
      },
    });
  }

  get port(): number {
    if (this.#server.port === undefined) throw new Error("IPC server has no bound port");
    return this.#server.port;
  }

  get workspace(): string {
    return this.#workspace;
  }

  emit(type: string, payload: unknown): void {
    const message = JSON.stringify({ version: 1, type, payload });
    for (const client of this.#clients) client.send(message);
  }

  emitAudio(pcm: Uint8Array): void {
    for (const client of this.#clients) client.send(pcm, true);
  }
  snapshot() {
    return this.#controller.snapshot();
  }
  getArtifacts(ids: readonly string[]): CapturedContext[] {
    return this.#artifacts.get(ids);
  }

  async executeCommand(input: unknown): Promise<ActionResult> {
    const command = parseCommand(input);
    if (command.type === "task.submit" && command.payload.repositoryId !== this.#workspace) {
      return {
        status: "rejected",
        code: "workspace_mismatch",
        explanation: "The task repository does not match the selected workspace",
      };
    }
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.handle(command);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }


  async pauseAtSafeBoundary(taskId: string, reason?: string): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskId, reason);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async awaitUserInput(taskId: string, question: string): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.awaitUserInput(Bun.randomUUIDv7(), taskId, question);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async completeTask(taskId: string, summary: string, evidenceIds: string[] = []): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.completeTask(Bun.randomUUIDv7(), taskId, summary, evidenceIds);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async failTask(taskId: string, error: string): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.failTask(Bun.randomUUIDv7(), taskId, error);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }
  async recoverAfterRestart(): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.recoverAfterRestart(Bun.randomUUIDv7());
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }


  close(): void {
    for (const client of this.#clients) client.close(1001, "Mamachi daemon stopped");
    this.#clients.clear();
    this.#server.stop(true);
    this.#store.close();
    this.#artifacts.close();
  }

  #handleUpgrade(request: Request, server: Server<ClientData>): Response | undefined {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: 1 });
    }
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
    if (!isAuthorized(request, this.#token)) return new Response("Unauthorized", { status: 401 });

    const upgraded = server.upgrade(request, {
      data: { id: Bun.randomUUIDv7() },
    });
    return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
  }

  async #handleMessage(socket: ClientSocket, text: string): Promise<void> {
    let requestId: string | undefined;
    try {
      const request = parseRequest(JSON.parse(text));
      requestId = request.id;
      const result = await this.#dispatch(request);
      this.#send(socket, "response", { requestId, ok: true, result });
    } catch (error) {
      this.#send(socket, "response", {
        requestId: requestId ?? null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #dispatch(request: RequestEnvelope): Promise<unknown> {
    switch (request.type) {
      case "state.get":
        this.#assertEmptyPayload(request.payload);
        return {
          workspace: this.#workspace,
          snapshot: this.#controller.snapshot(),
        };
      case "workspace.select":
      case "workspace.focus": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["path"]) ||
          typeof request.payload["path"] !== "string"
        ) {
          throw new Error(`${request.type} requires one path string`);
        }
        const path = realpathSync(request.payload["path"]);
        if (!statSync(path).isDirectory()) throw new Error("Selected workspace is not a directory");
        this.#workspace = path;
        this.emit("workspace.changed", { path, source: request.type === "workspace.focus" ? "vscode" : "user" });
        return { path };
      }
      case "context.capture": {
        const allowedKeys = [
          "kind",
          "workspace",
          "path",
          "language",
          "selection",
          "range",
          "diagnostics",
          "terminalExcerpt",
        ];
        if (!isObject(request.payload) || !hasOnlyKeys(request.payload, allowedKeys)) {
          throw new Error("context.capture payload is invalid");
        }
        const kind = request.payload["kind"];
        const workspace = request.payload["workspace"];
        const supportedKinds = new Set<ContextKind>(["active_file", "selection", "diagnostics", "terminal_excerpt"]);
        if (typeof kind !== "string" || !supportedKinds.has(kind as ContextKind)) {
          throw new Error("context.capture kind is invalid");
        }
        if (typeof workspace !== "string" || realpathSync(workspace) !== this.#workspace) {
          throw new Error("Captured context does not belong to the selected workspace");
        }
        for (const key of ["path", "language", "selection", "terminalExcerpt"]) {
          const value = request.payload[key];
          if (value !== undefined && typeof value !== "string") throw new Error(`context.capture ${key} must be a string`);
        }
        if (request.payload["range"] !== undefined && !isObject(request.payload["range"])) {
          throw new Error("context.capture range must be an object");
        }
        if (request.payload["diagnostics"] !== undefined && !Array.isArray(request.payload["diagnostics"])) {
          throw new Error("context.capture diagnostics must be an array");
        }
        const path = typeof request.payload["path"] === "string" ? request.payload["path"] : null;
        if (path) {
          const relativePath = relative(this.#workspace, path);
          if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
            throw new Error("Captured file is outside the selected workspace");
          }
        }
        const summary =
          kind === "active_file"
            ? `Active file: ${path ?? "unknown"}`
            : kind === "selection"
              ? `Explicit selection: ${path ?? "unknown"}`
              : kind === "diagnostics"
                ? `Diagnostics: ${path ?? "workspace"}`
                : "Explicit terminal excerpt";
        const artifact = this.#artifacts.capture(
          kind as ContextKind,
          this.#workspace,
          summary,
          request.payload,
        );
        this.emit("context.captured", {
          id: artifact.id,
          kind: artifact.kind,
          workspace: artifact.workspace,
          summary: artifact.summary,
        });
        this.#hooks.onContextCaptured?.(artifact);
        return { id: artifact.id, kind: artifact.kind, summary: artifact.summary };
      }
      case "command.execute": {
        if (!isObject(request.payload) || !hasOnlyKeys(request.payload, ["command"])) {
          throw new Error("command.execute requires one command");
        }
        return this.executeCommand(request.payload["command"]);
      }
      case "settings.update": {
        const settings = parseRuntimeSettings(request.payload);
        this.#hooks.onSettingsUpdate?.(settings);
        this.emit("settings.updated", settings);
        return settings;
      }
      case "voice.connect": {
        if (!isObject(request.payload) || !hasOnlyKeys(request.payload, ["apiKey"])) {
          throw new Error("voice.connect payload is invalid");
        }
        const apiKey = request.payload["apiKey"];
        if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length === 0)) {
          throw new Error("voice.connect apiKey must be a non-empty string");
        }
        await this.#hooks.onVoiceConnect?.(apiKey);
        return { connected: true };
      }
      case "voice.mode": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["mode"]) ||
          !(request.payload["mode"] === "voice" || request.payload["mode"] === "text")
        ) {
          throw new Error("voice.mode requires mode voice or text");
        }
        this.#hooks.onVoiceMode?.(request.payload["mode"]);
        return { mode: request.payload["mode"] };
      }
      case "voice.disconnect":
        this.#assertEmptyPayload(request.payload);
        await this.#hooks.onVoiceDisconnect?.();
        return { connected: false };
      case "voice.interrupt":
        this.#assertEmptyPayload(request.payload);
        this.#hooks.onVoiceInterrupt?.();
        return { interrupted: true };
      case "voice.text": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["text"]) ||
          typeof request.payload["text"] !== "string"
        ) {
          throw new Error("voice.text requires one text string");
        }
        await this.#hooks.onVoiceText?.(request.payload["text"]);
        return { accepted: true };
      }
    }
  }

  async #publishControllerEvents(beforeSeq: number): Promise<void> {
    const events = this.#controller.eventsAfter(beforeSeq);
    for (const event of events) this.emit("domain.event", event);
    if (events.length === 0) return;
    this.emit("state.snapshot", {
      workspace: this.#workspace,
      snapshot: this.#controller.snapshot(),
    });
    await this.#hooks.onTaskEvents?.(events);
  }

  #assertEmptyPayload(payload: unknown): void {
    if (!isObject(payload) || Object.keys(payload).length !== 0) throw new Error("Request payload must be empty");
  }

  #send(socket: ClientSocket, type: string, payload: unknown): void {
    socket.send(JSON.stringify({ version: 1, type, payload }));
  }
}
