import { describe, expect, test } from "bun:test";
import type { RawData } from "ws";
import {
  MamachiBridge,
  type ConnectionDescriptor,
  type DomainEventEnvelope,
  type MamachiBridgeOptions,
} from "../src/realtime-client";

interface SentRequest {
  version: number;
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

type Listener = (...args: never[]) => void;

class FakeSocket {
  readyState = 0;
  readonly sent: SentRequest[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #onceListeners = new Map<string, Set<Listener>>();
  readonly #sendCallbacks = new Map<string, (error?: Error) => void>();

  once(event: "open" | "close" | "error", listener: Listener): this {
    const listeners = this.#onceListeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#onceListeners.set(event, listeners);
    return this;
  }

  on(event: "message", listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  send(data: string, callback: (error?: Error) => void): void {
    const request = JSON.parse(data) as SentRequest;
    this.sent.push(request);
    this.#sendCallbacks.set(request.id, callback);
    callback();
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close");
  }

  terminate(): void {
    this.close();
  }

  open(): void {
    this.readyState = 1;
    this.#emit("open");
  }

  event(event: DomainEventEnvelope): void {
    this.#message({ version: 1, type: "domain.event", payload: event });
  }

  serverEvent(type: string, payload: Record<string, unknown>): void {
    this.#message({ version: 1, type, payload });
  }

  respond(request: SentRequest, result: unknown): void {
    this.#message({
      version: 1,
      type: "response",
      payload: { requestId: request.id, ok: true, result },
    });
  }

  failSend(request: SentRequest, error: Error): void {
    this.#sendCallbacks.get(request.id)?.(error);
  }

  request(type: string): SentRequest {
    const request = this.sent.findLast((candidate) => candidate.type === type);
    if (!request) throw new Error(`No ${type} request was sent`);
    return request;
  }

  #message(value: unknown): void {
    this.#emit("message", Buffer.from(JSON.stringify(value)) as RawData, false);
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...(args as never[]));
    const once = this.#onceListeners.get(event);
    this.#onceListeners.delete(event);
    for (const listener of once ?? []) listener(...(args as never[]));
  }
}

class Harness {
  readonly sockets: FakeSocket[] = [];
  readonly bridge: MamachiBridge;

  constructor(options: Partial<MamachiBridgeOptions> = {}) {
    const descriptor: ConnectionDescriptor = {
      version: 1,
      pid: 1,
      port: 9_999,
      token: "test",
      workspace: "/workspace",
    };
    this.bridge = new MamachiBridge({
      loadDescriptor: async () => descriptor,
      createSocket: () => {
        const socket = new FakeSocket();
        this.sockets.push(socket);
        return socket;
      },
      scheduleReconnect: (callback) => {
        queueMicrotask(callback);
        return {} as NodeJS.Timeout;
      },
      reconnectDelaysMs: [1],
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      ...options,
    });
  }

  async nextSocket(index: number): Promise<FakeSocket> {
    await eventually(() => this.sockets.length > index);
    const socket = this.sockets[index];
    if (!socket) throw new Error(`Socket ${index} was not created`);
    return socket;
  }

  async synchronize(socket: FakeSocket, seq: number, events: DomainEventEnvelope[] = []): Promise<SentRequest> {
    socket.open();
    await eventually(() => socket.sent.some((request) => request.type === "state.get"));
    const request = socket.request("state.get");
    socket.respond(request, {
      workspace: "/workspace",
      snapshot: { seq, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] },
      facts: {},
      events,
      reset: false,
    });
    await eventually(() => this.bridge.state === "connected");
    return request;
  }
}

function domainEvent(id: string, seq: number): DomainEventEnvelope {
  return {
    version: 1,
    id,
    seq,
    at: "2026-07-22T00:00:00.000Z",
    type: "task.completed",
    actor: "controller",
    correlationId: id,
    payload: { taskId: id },
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
  throw new Error("Condition was not reached");
}

describe("MamachiBridge durable reconnect", () => {
  test("buffers the snapshot/live gap and applies replay, duplicates, and out-of-order events at most once", async () => {
    const harness = new Harness({ dedupeLimit: 4 });
    const applied: string[] = [];
    const snapshots: number[] = [];
    harness.bridge.onEvent = (type, payload) => {
      if (type === "domain.event") applied.push(payload["id"] as string);
    };
    harness.bridge.onSnapshot = (result) => snapshots.push(result.snapshot.seq);
    harness.bridge.start();

    const first = await harness.nextSocket(0);
    await harness.synchronize(first, 10);
    first.close();

    const second = await harness.nextSocket(1);
    second.open();
    await eventually(() => second.sent.some((request) => request.type === "state.get"));
    expect(second.request("state.get").payload).toEqual({ afterSeq: 10 });
    second.event(domainEvent("live-11", 11));
    second.respond(second.request("state.get"), {
      workspace: "/workspace",
      snapshot: { seq: 10 },
      facts: {},
      events: [domainEvent("live-11", 11)],
      reset: false,
    });
    await eventually(() => harness.bridge.state === "connected");

    second.event(domainEvent("live-11", 11));
    second.event(domainEvent("live-13", 13));
    second.event(domainEvent("late-12", 12));
    expect(applied).toEqual(["live-11", "live-13"]);
    expect(harness.bridge.lastSeq).toBe(13);
    second.close();

    const third = await harness.nextSocket(2);
    third.open();
    await eventually(() => third.sent.some((request) => request.type === "state.get"));
    expect(third.request("state.get").payload).toEqual({ afterSeq: 13 });
    third.event(domainEvent("replayed-15", 15));
    third.respond(third.request("state.get"), {
      workspace: "/workspace",
      snapshot: { seq: 13 },
      facts: {},
      events: [domainEvent("replayed-14", 14), domainEvent("replayed-15", 15)],
      reset: false,
    });
    await eventually(() => harness.bridge.state === "connected");
    third.event(domainEvent("replayed-14", 14));
    third.event(domainEvent("replayed-15", 15));

    expect(snapshots).toEqual([10, 10, 13]);
    expect(applied).toEqual(["live-11", "live-13", "replayed-14", "replayed-15"]);
    expect(harness.bridge.lastSeq).toBe(15);
    harness.bridge.dispose();
  });

  test("rejects stale socket traffic and settles a disconnected request only once", async () => {
    const harness = new Harness();
    const snapshots: number[] = [];
    harness.bridge.onSnapshot = (result) => snapshots.push(result.snapshot.seq);
    harness.bridge.start();
    const first = await harness.nextSocket(0);
    await harness.synchronize(first, 2);

    let rejectionCount = 0;
    const capture = harness.bridge.request("context.capture", { kind: "selection" }).catch((error: unknown) => {
      rejectionCount += 1;
      throw error;
    });
    await eventually(() => first.sent.some((request) => request.type === "context.capture"));
    const staleRequest = first.request("context.capture");
    first.close();
    first.failSend(staleRequest, new Error("late send failure"));
    first.respond(staleRequest, { summary: "stale" });
    await expect(capture).rejects.toThrow("connection closed");
    expect(rejectionCount).toBe(1);

    const second = await harness.nextSocket(1);
    await harness.synchronize(second, 2);
    first.respond(first.request("state.get"), {
      snapshot: { seq: 99 },
      events: [],
      reset: false,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(harness.bridge.lastSeq).toBe(2);
    harness.bridge.dispose();
  });

  test("queues focus, context capture, and editor state during backoff and sends each once after reconnect", async () => {
    const harness = new Harness();
    harness.bridge.start();
    const first = await harness.nextSocket(0);
    await harness.synchronize(first, 0);
    first.close();

    const focus = harness.bridge.request("workspace.focus", { path: "/workspace" });
    const capture = harness.bridge.request("context.capture", { kind: "active_file", workspace: "/workspace" });
    const editor = harness.bridge.request("editor.state", {
      workspace: "/workspace",
      path: "/workspace/file.ts",
      version: 4,
      dirty: true,
      open: true,
    });

    const second = await harness.nextSocket(1);
    await harness.synchronize(second, 0);
    await eventually(() => second.sent.filter((request) => request.type !== "state.get").length === 3);
    for (const type of ["workspace.focus", "context.capture", "editor.state"]) {
      const requests = second.sent.filter((request) => request.type === type);
      expect(requests).toHaveLength(1);
      second.respond(requests[0]!, {});
    }
    await Promise.all([focus, capture, editor]);
    expect(first.sent.filter((request) => request.type !== "state.get")).toHaveLength(0);
    harness.bridge.dispose();
  });
  test("correlates bounded editor context requests and rejects malformed server requests", async () => {
    const harness = new Harness();
    const received: Array<{ requestId: string; kinds: string[]; workspace: string }> = [];
    harness.bridge.onEditorContextRequest = async (request) => {
      received.push(request);
      return {
        captures: request.kinds.map((kind) => ({ kind, payload: { path: "/workspace/file.ts" } })),
        errors: [],
      };
    };
    harness.bridge.start();
    const socket = await harness.nextSocket(0);
    await harness.synchronize(socket, 0);

    socket.serverEvent("editor.context.request", {
      requestId: "capture-1",
      kinds: ["active_file", "diagnostics"],
      workspace: "/workspace",
    });
    await eventually(() => socket.sent.some((request) => request.type === "editor.context.response"));
    const response = socket.request("editor.context.response");
    expect(received).toEqual([
      { requestId: "capture-1", kinds: ["active_file", "diagnostics"], workspace: "/workspace" },
    ]);
    expect(response.payload).toEqual({
      requestId: "capture-1",
      captures: [
        { kind: "active_file", payload: { path: "/workspace/file.ts" } },
        { kind: "diagnostics", payload: { path: "/workspace/file.ts" } },
      ],
      errors: [],
    });
    socket.respond(response, { accepted: true });

    socket.serverEvent("editor.context.request", {
      requestId: "capture-2",
      kinds: ["selection"],
      workspace: "/workspace",
      unexpected: true,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(socket.sent.filter((request) => request.type === "editor.context.response")).toHaveLength(1);
    harness.bridge.dispose();
  });

  test("uses deterministic exponential backoff capped at five seconds", async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const bridge = new MamachiBridge({
      loadDescriptor: async () => {
        throw new Error("offline");
      },
      scheduleReconnect: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return {} as NodeJS.Timeout;
      },
    });
    bridge.start();

    while (scheduled.length === 0) await new Promise<void>((resolve) => queueMicrotask(resolve));
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = scheduled.shift();
      if (!next) throw new Error("Reconnect was not scheduled");
      delays.push(next.delayMs);
      if (attempt === 7) break;
      next.callback();
      await eventually(() => scheduled.length > 0);
    }

    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
    bridge.dispose();
  });

});
