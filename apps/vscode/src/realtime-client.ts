import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";
import {
  EVENT_TYPES,
  PROTOCOL_ENVELOPE_VERSION,
  type DomainEventEnvelope,
} from "./generated/protocol.generated";
export type { DomainEventEnvelope } from "./generated/protocol.generated";

export interface ConnectionDescriptor {
  version: 1;
  pid: number;
  port: number;
  token: string;
  workspace: string;
}

export type ConnectionState = "idle" | "connecting" | "synchronizing" | "connected" | "backoff" | "disposed";

export type EditorContextKind = "active_file" | "selection" | "diagnostics" | "terminal_excerpt";

export interface EditorContextCapture {
  kind: EditorContextKind;
  payload: Record<string, unknown>;
}

export interface EditorContextError {
  kind: EditorContextKind;
  error: string;
}

export interface EditorContextRequest {
  requestId: string;
  kinds: EditorContextKind[];
  workspace: string;
}

export interface EditorContextResponse {
  captures: EditorContextCapture[];
  errors: EditorContextError[];
}


export interface StateResult extends Record<string, unknown> {
  snapshot: Record<string, unknown> & { seq: number };
  events: DomainEventEnvelope[];
  reset: boolean;
}

interface PendingRequest {
  socket: SocketLike;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface SocketLike {
  readonly readyState: number;
  once(event: "open", listener: () => void): this;
  once(event: "close", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface MamachiBridgeOptions {
  loadDescriptor?: () => Promise<ConnectionDescriptor>;
  createSocket?: (descriptor: ConnectionDescriptor) => SocketLike;
  reconnectDelaysMs?: readonly number[];
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  dedupeLimit?: number;
  scheduleReconnect?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const eventTypes = new Set<string>(EVENT_TYPES);

function parseDescriptor(value: unknown): ConnectionDescriptor {
  if (
    !isObject(value) ||
    value["version"] !== 1 ||
    typeof value["pid"] !== "number" ||
    typeof value["port"] !== "number" ||
    typeof value["token"] !== "string" ||
    typeof value["workspace"] !== "string"
  ) {
    throw new Error("Mamachi connection descriptor is invalid");
  }
  return value as unknown as ConnectionDescriptor;
}

function parseDomainEvent(value: unknown): DomainEventEnvelope | null {
  if (
    !isObject(value) ||
    value["version"] !== PROTOCOL_ENVELOPE_VERSION ||
    typeof value["id"] !== "string" ||
    !Number.isSafeInteger(value["seq"]) ||
    (value["seq"] as number) < 1 ||
    typeof value["type"] !== "string" ||
    !eventTypes.has(value["type"]) ||
    typeof value["at"] !== "string" ||
    typeof value["actor"] !== "string" ||
    typeof value["correlationId"] !== "string" ||
    !isObject(value["payload"])
  ) {
    return null;
  }
  return value as unknown as DomainEventEnvelope;
}

function parseStateResult(value: unknown): StateResult {
  if (!isObject(value) || !isObject(value["snapshot"]) || !Array.isArray(value["events"])) {
    throw new Error("Mamachi state.get result is invalid");
  }
  const seq = value["snapshot"]["seq"];
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || typeof value["reset"] !== "boolean") {
    throw new Error("Mamachi state.get result is invalid");
  }
  const events: DomainEventEnvelope[] = [];
  for (const candidate of value["events"]) {
    const event = parseDomainEvent(candidate);
    if (!event) throw new Error("Mamachi state.get replay event is invalid");
    events.push(event);
  }
  return { ...value, snapshot: value["snapshot"] as StateResult["snapshot"], events, reset: value["reset"] };
}

export class MamachiBridge {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #seenEventIds = new Map<string, true>();
  readonly #loadDescriptor: () => Promise<ConnectionDescriptor>;
  readonly #createSocket: (descriptor: ConnectionDescriptor) => SocketLike;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #connectTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #dedupeLimit: number;
  readonly #scheduleReconnectCallback: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  #socket: SocketLike | null = null;
  #connecting: Promise<void> | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconnectAttempt = 0;
  #state: ConnectionState = "idle";
  #started = false;
  #disposed = false;
  #lastSeq: number | null = null;
  #bufferedDomainEvents: DomainEventEnvelope[] = [];

  onStatus: (connected: boolean, detail: string) => void = () => {};
  onStateChange: (state: ConnectionState) => void = () => {};
  onSnapshot: (result: StateResult) => void = () => {};
  onEvent: (type: string, payload: Record<string, unknown> | DomainEventEnvelope) => void = () => {};
  onReady: () => void = () => {};
  onEditorContextRequest: ((request: EditorContextRequest) => Promise<EditorContextResponse>) | null = null;

  constructor(options: MamachiBridgeOptions = {}) {
    const connectionPath =
      process.env["MAMACHI_CONNECTION_PATH"] ?? join(homedir(), "Library", "Application Support", "Mamachi", "connection.json");
    this.#loadDescriptor =
      options.loadDescriptor ??
      (async () => parseDescriptor(JSON.parse(await readFile(connectionPath, "utf8")) as unknown));
    this.#createSocket =
      options.createSocket ??
      ((descriptor) =>
        new WebSocket(`ws://127.0.0.1:${descriptor.port}/ws`, {
          headers: { Authorization: `Bearer ${descriptor.token}` },
        }));
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [250, 500, 1_000, 2_000, 4_000, 5_000];
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#scheduleReconnectCallback = options.scheduleReconnect ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#dedupeLimit = Math.max(1, options.dedupeLimit ?? 2_048);
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get lastSeq(): number | null {
    return this.#lastSeq;
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#beginConnect();
  }

  async connect(): Promise<void> {
    this.start();
    if (this.#state === "connected") return;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.#beginConnect();
    }
    await new Promise<void>((resolve, reject) => this.#readyWaiters.add({ resolve, reject }));
  }

  async request(type: string, payload: Record<string, unknown>): Promise<unknown> {
    for (;;) {
      await this.connect();
      const socket = this.#socket;
      if (socket && this.#state === "connected" && socket.readyState === WebSocket.OPEN) {
        return this.#sendRequest(socket, type, payload);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#started = false;
    this.#setState("disposed");
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, "VS Code extension deactivated");
    const error = new Error("Mamachi extension deactivated");
    this.#rejectPendingForSocket(null, error);
    for (const waiter of this.#readyWaiters) waiter.reject(error);
    this.#readyWaiters.clear();
  }

  #beginConnect(): void {
    if (this.#disposed || this.#connecting || this.#socket) return;
    this.#connecting = this.#open()
      .catch((error: unknown) => {
        if (this.#disposed) return;
        this.onStatus(false, error instanceof Error ? error.message : "Start the Mamachi app");
        this.#scheduleReconnect();
      })
      .finally(() => {
        this.#connecting = null;
        if (this.#state === "backoff" && !this.#reconnectTimer && !this.#socket && !this.#disposed) this.#beginConnect();
      });
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer) return;
    const index = Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1);
    const delay = this.#reconnectDelaysMs[index] ?? 5_000;
    this.#reconnectAttempt += 1;
    this.#setState("backoff");
    this.#reconnectTimer = this.#scheduleReconnectCallback(() => {
      this.#reconnectTimer = null;
      this.#beginConnect();
    }, delay);
  }

  async #open(): Promise<void> {
    this.#setState("connecting");
    let descriptor: ConnectionDescriptor;
    try {
      descriptor = await this.#loadDescriptor();
    } catch {
      throw new Error("Start the Mamachi app");
    }
    if (this.#disposed) return;

    const socket = this.#createSocket(descriptor);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let setupSettled = false;
    const settleSetup = (error?: Error): void => {
      if (setupSettled) return;
      setupSettled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      socket.terminate();
      settleSetup(new Error("Mamachi connection timed out"));
    }, this.#connectTimeoutMs);

    socket.once("open", () => {
      if (this.#disposed) {
        socket.close();
        settleSetup(new Error("Mamachi extension deactivated"));
        return;
      }
      this.#socket = socket;
      this.#bufferedDomainEvents = [];
      this.#setState("synchronizing");
      void this.#synchronize(socket, descriptor).then(
        () => settleSetup(),
        (error: Error) => {
          settleSetup(error);
          socket.terminate();
        },
      );
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.#handleMessage(socket, data);
    });
    socket.once("close", () => {
      const wasCurrent = this.#socket === socket;
      if (wasCurrent) {
        this.#socket = null;
        this.#bufferedDomainEvents = [];
        this.onStatus(false, "Reconnecting…");
        this.#rejectPendingForSocket(socket, new Error("Mamachi connection closed"));
        this.#scheduleReconnect();
      }
      settleSetup(new Error("Mamachi connection closed during setup"));
    });
    socket.once("error", (error) => {
      settleSetup(error);
      socket.terminate();
    });
    await promise;
  }

  async #synchronize(socket: SocketLike, descriptor: ConnectionDescriptor): Promise<void> {
    const requestedAfterSeq = this.#lastSeq;
    const rawResult = await this.#sendRequest(socket, "state.get", { afterSeq: requestedAfterSeq });
    if (socket !== this.#socket || this.#disposed) throw new Error("Mamachi socket was replaced during synchronization");
    const result = parseStateResult(rawResult);
    const snapshotSeq = result.snapshot.seq;
    if (!result.reset && requestedAfterSeq !== null && snapshotSeq < requestedAfterSeq) {
      throw new Error("Mamachi state snapshot moved behind the requested sequence");
    }

    if (result.reset) this.#seenEventIds.clear();
    this.onSnapshot(result);
    this.#lastSeq = snapshotSeq;
    for (const event of result.events) {
      if (event.seq <= snapshotSeq) this.#rememberEventId(event.id);
      else this.#applyDomainEvent(event);
    }
    for (const event of this.#bufferedDomainEvents) this.#applyDomainEvent(event);
    this.#bufferedDomainEvents = [];

    if (socket !== this.#socket || this.#disposed) throw new Error("Mamachi socket was replaced during synchronization");
    this.#reconnectAttempt = 0;
    this.#setState("connected");
    this.onStatus(true, `Connected on port ${descriptor.port}`);
    for (const waiter of this.#readyWaiters) waiter.resolve();
    this.#readyWaiters.clear();
    this.onReady();
  }

  #sendRequest(socket: SocketLike, type: string, payload: Record<string, unknown>): Promise<unknown> {
    if (socket !== this.#socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Mamachi is not connected"));
    }
    const id = crypto.randomUUID();
    const message = JSON.stringify({ version: PROTOCOL_ENVELOPE_VERSION, id, type, payload });
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeout = setTimeout(() => {
      this.#settlePending(id, new Error(`Mamachi request timed out: ${type}`));
    }, this.#requestTimeoutMs);
    this.#pending.set(id, { socket, resolve, reject, timeout });
    socket.send(message, (error) => {
      if (error) this.#settlePending(id, error);
    });
    return promise;
  }

  #handleMessage(socket: SocketLike, data: RawData): void {
    if (socket !== this.#socket || this.#disposed) return;
    let message: unknown;
    try {
      message = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }
    if (
      !isObject(message) ||
      message["version"] !== PROTOCOL_ENVELOPE_VERSION ||
      typeof message["type"] !== "string"
    ) return;
    const payload = isObject(message["payload"]) ? message["payload"] : {};
    if (message["type"] === "response") {
      const requestId = payload["requestId"];
      if (typeof requestId !== "string") return;
      const pending = this.#pending.get(requestId);
      if (!pending || pending.socket !== socket) return;
      if (payload["ok"] === true) this.#settlePending(requestId, undefined, payload["result"]);
      else {
        this.#settlePending(
          requestId,
          new Error(typeof payload["error"] === "string" ? payload["error"] : "Mamachi request failed"),
        );
      }
      return;
    }
    if (message["type"] === "domain.event") {
      const event = parseDomainEvent(payload);
      if (!event) return;
      if (this.#state === "synchronizing") this.#bufferedDomainEvents.push(event);
      else if (this.#state === "connected") this.#applyDomainEvent(event);
      return;
    }
    if (message["type"] === "editor.context.request") {
      void this.#handleEditorContextRequest(payload);
      return;
    }
    this.onEvent(message["type"], payload);
  }

  async #handleEditorContextRequest(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload["requestId"];
    const kinds = payload["kinds"];
    const workspace = payload["workspace"];
    const allowed = new Set<EditorContextKind>(["active_file", "selection", "diagnostics", "terminal_excerpt"]);
    if (
      Object.keys(payload).some((key) => key !== "requestId" && key !== "kinds" && key !== "workspace") ||
      typeof requestId !== "string" ||
      typeof workspace !== "string" ||
      !Array.isArray(kinds) ||
      kinds.length === 0 ||
      kinds.length > allowed.size ||
      kinds.some((kind) => typeof kind !== "string" || !allowed.has(kind as EditorContextKind)) ||
      new Set(kinds).size !== kinds.length
    ) {
      return;
    }
    const request: EditorContextRequest = { requestId, kinds: kinds as EditorContextKind[], workspace };
    let response: EditorContextResponse;
    try {
      response = this.onEditorContextRequest
        ? await this.onEditorContextRequest(request)
        : {
            captures: [],
            errors: request.kinds.map((kind) => ({ kind, error: "Editor context capture is unsupported by this client" })),
          };
    } catch (error) {
      response = {
        captures: [],
        errors: request.kinds.map((kind) => ({
          kind,
          error: error instanceof Error ? error.message : String(error),
        })),
      };
    }
    await this.request("editor.context.response", { requestId, captures: response.captures, errors: response.errors });
  }

  #applyDomainEvent(event: DomainEventEnvelope): void {
    if (this.#seenEventIds.has(event.id)) return;
    if (this.#lastSeq !== null && event.seq <= this.#lastSeq) {
      this.#rememberEventId(event.id);
      return;
    }
    this.#rememberEventId(event.id);
    this.#lastSeq = event.seq;
    this.onEvent("domain.event", event);
  }

  #rememberEventId(id: string): void {
    if (this.#seenEventIds.delete(id)) this.#seenEventIds.set(id, true);
    else this.#seenEventIds.set(id, true);
    while (this.#seenEventIds.size > this.#dedupeLimit) {
      const oldest = this.#seenEventIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#seenEventIds.delete(oldest);
    }
  }

  #settlePending(id: string, error?: Error, value?: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  #rejectPendingForSocket(socket: SocketLike | null, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (socket === null || pending.socket === socket) this.#settlePending(id, error);
    }
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.onStateChange(state);
  }
}
