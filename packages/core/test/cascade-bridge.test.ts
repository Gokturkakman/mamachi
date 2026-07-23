import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import { CascadeBridge } from "../src/cascade-bridge.ts";
import type { ControllerSnapshot } from "../src/domain.ts";
import type {
  CascadeBridgeOptions,
  VoiceFunctionTool,
  VoiceToolHost,
  VoiceToolkit,
} from "../src/voice-bridge.ts";

interface SocketData {
  kind: "stt" | "tts";
}

interface Emitted {
  type: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateOf(entry: Emitted): unknown {
  return entry.type === "voice.state" && isRecord(entry.payload) ? entry.payload["state"] : undefined;
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

interface FakeToolkit extends VoiceToolkit {
  executed: Array<{ name: string; input: unknown }>;
  harnessNotes: Array<{ type: string; payload: unknown }>;
  cleared: string[];
  host: VoiceToolHost | null;
}

function createFakeToolkit(executeResult: unknown = { status: "ok" }): FakeToolkit {
  const toolkit: FakeToolkit = {
    executed: [],
    harnessNotes: [],
    cleared: [],
    host: null,
    instructions: () => "Cascade test instructions.",
    tools: (): VoiceFunctionTool[] => [{
      type: "function",
      name: "get_task_status",
      description: "Report the status of a coding task.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }],
    execute: async (name, input) => {
      toolkit.executed.push({ name, input });
      return executeResult;
    },
    noteHarnessEvent: (type, payload) => {
      toolkit.harnessNotes.push({ type, payload });
    },
    captureContext: () => {},
    discardContext: () => {},
    pendingContexts: () => [],
    clearPendingComputerControls: (reason) => {
      toolkit.cleared.push(reason);
    },
    dispose: () => {},
  };
  return toolkit;
}

interface Providers {
  server: Server<SocketData>;
  port: number;
  sttSockets: ServerWebSocket<SocketData>[];
  ttsSockets: ServerWebSocket<SocketData>[];
  sttMessages: Record<string, unknown>[];
  ttsMessages: Record<string, unknown>[];
  sttRequests: Array<{ search: string; apiKey: string | null }>;
  ttsRequests: Array<{ path: string; apiKey: string | null }>;
  responsesBodies: Record<string, unknown>[];
  responsesAuth: Array<string | null>;
  responseQueue: Array<(body: Record<string, unknown>) => string>;
  onTtsMessage: ((socket: ServerWebSocket<SocketData>, event: Record<string, unknown>) => void) | null;
  notify: () => void;
  /// Resolve once `get` yields a value; re-armed by every recorded provider
  /// event or bridge emission — no wall-clock polling. A hung predicate fails
  /// via the test runner timeout.
  until: <T>(get: () => T | undefined | false) => Promise<T>;
}

function startProviders(): Providers {
  const waiters: Array<{ check: () => boolean; resolve: () => void }> = [];
  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.check()) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };
  const providers: Providers = {
    server: undefined as unknown as Server<SocketData>,
    port: 0,
    sttSockets: [],
    ttsSockets: [],
    sttMessages: [],
    ttsMessages: [],
    sttRequests: [],
    ttsRequests: [],
    responsesBodies: [],
    responsesAuth: [],
    responseQueue: [],
    onTtsMessage: null,
    notify,
    until: async <T>(get: () => T | undefined | false): Promise<T> => {
      for (;;) {
        const value = get();
        if (value !== undefined && value !== false) return value;
        await new Promise<void>((resolve) => {
          waiters.push({
            check: () => {
              const checked = get();
              return checked !== undefined && checked !== false;
            },
            resolve,
          });
        });
      }
    },
  };
  providers.server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/stt") {
        providers.sttRequests.push({ search: url.search, apiKey: request.headers.get("xi-api-key") });
        notify();
        const upgraded = bunServer.upgrade(request, { data: { kind: "stt" as const } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/tts/")) {
        providers.ttsRequests.push({ path: url.pathname + url.search, apiKey: request.headers.get("xi-api-key") });
        notify();
        const upgraded = bunServer.upgrade(request, { data: { kind: "tts" as const } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/responses" && request.method === "POST") {
        return (async () => {
          const body = await request.json() as Record<string, unknown>;
          providers.responsesBodies.push(body);
          providers.responsesAuth.push(request.headers.get("authorization"));
          notify();
          const handler = providers.responseQueue.shift();
          if (!handler) return new Response("no scripted response", { status: 500 });
          return new Response(handler(body), {
            headers: { "Content-Type": "text/event-stream" },
          });
        })();
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        if (socket.data.kind === "stt") {
          providers.sttSockets.push(socket);
          socket.send(JSON.stringify({
            message_type: "session_started",
            session_id: "scribe_session_test",
            config: {},
          }));
        } else {
          providers.ttsSockets.push(socket);
        }
        notify();
      },
      message(socket, message) {
        if (typeof message !== "string") return;
        const event = JSON.parse(message) as Record<string, unknown>;
        if (socket.data.kind === "stt") {
          providers.sttMessages.push(event);
        } else {
          providers.ttsMessages.push(event);
          providers.onTtsMessage?.(socket, event);
        }
        notify();
      },
    },
  });
  const port = providers.server.port;
  if (port === undefined) throw new Error("mock provider server did not bind a port");
  providers.port = port;
  return providers;
}

const activeBridges: CascadeBridge[] = [];

function bridgeFor(
  providers: Providers,
  toolkit: FakeToolkit,
  emitted: Emitted[],
  audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }>,
  extra: Partial<CascadeBridgeOptions> = {},
): CascadeBridge {
  const snapshot: ControllerSnapshot = {
    seq: 0,
    activeTaskId: null,
    queue: [],
    tasks: [],
    runs: [],
    confirmations: [],
  };
  const bridge = new CascadeBridge({
    openaiApiKey: "test-openai-key",
    elevenLabsApiKey: "test-eleven-key",
    sttEndpoint: `ws://127.0.0.1:${providers.port}/stt`,
    ttsEndpoint: `ws://127.0.0.1:${providers.port}/tts`,
    responsesEndpoint: `http://127.0.0.1:${providers.port}/responses`,
    getWorkspace: () => "/tmp/mamachi-workspace",
    getSnapshot: () => snapshot,
    executeCommand: async (): Promise<ActionResult> => ({
      status: "accepted",
      eventId: Bun.randomUUIDv7(),
      taskId: Bun.randomUUIDv7(),
    }),
    emit: (type, payload) => {
      emitted.push({ type, payload });
      providers.notify();
    },
    emitAudio: (pcm, playback) => {
      audio.push({ pcm, playback });
      providers.notify();
    },
    createToolkit: (host) => {
      toolkit.host = host;
      return toolkit;
    },
    reconnectDelaysMs: [10],
    ...extra,
  });
  activeBridges.push(bridge);
  return bridge;
}

function makeEvent(type: DomainEvent["type"], taskId: string, payload: unknown): DomainEvent {
  return {
    version: 1,
    id: Bun.randomUUIDv7(),
    seq: 1,
    at: new Date().toISOString(),
    type,
    actor: "controller",
    taskId,
    runId: Bun.randomUUIDv7(),
    payload,
  } as DomainEvent;
}

describe("CascadeBridge", () => {
  let providers: Providers | undefined;

  afterEach(async () => {
    // Disconnect first so reconnect timers stop before the mock server dies;
    // otherwise orphaned ws clients error after the test ends.
    for (const bridge of activeBridges.splice(0)) await bridge.disconnect();
    providers?.server.stop(true);
    providers = undefined;
  });

  test("connect rejects when a provider key is missing", async () => {
    const base = {
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: (): ControllerSnapshot => ({
        seq: 0,
        activeTaskId: null,
        queue: [],
        tasks: [],
        runs: [],
        confirmations: [],
      }),
      executeCommand: async (): Promise<ActionResult> => ({
        status: "accepted",
        eventId: Bun.randomUUIDv7(),
        taskId: Bun.randomUUIDv7(),
      }),
      emit: () => {},
      emitAudio: () => {},
      createToolkit: () => createFakeToolkit(),
    };
    const noEleven = new CascadeBridge({ ...base, openaiApiKey: "test-openai-key" });
    await expect(noEleven.connect()).rejects.toThrow("Cascade voice requires an ElevenLabs API key");

    const noOpenai = new CascadeBridge(base);
    await expect(noOpenai.connect({ elevenLabsApiKey: "test-eleven-key" }))
      .rejects.toThrow("Cascade voice requires an OpenAI API key");
  });

  test("streams a committed utterance through the LLM into TTS with a stable itemId", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "Hello the" },
      { type: "response.output_text.delta", delta: "re. " },
      { type: "response.output_text.delta", delta: "More soon" },
      { type: "response.completed", response: {} },
    ]));
    const chunk = Buffer.alloc(4_800, 3);
    state.onTtsMessage = (socket, event) => {
      // The assembler sends the completed sentence mid-stream, not deltas.
      if (event["text"] === "Hello there. ") {
        socket.send(JSON.stringify({
          audio: chunk.toString("base64"),
          alignment: {
            chars: ["H", "e"],
            charStartTimesMs: [0, 40],
            charDurationsMs: [40, 40],
          },
        }));
        socket.send(JSON.stringify({ audio: chunk.toString("base64") }));
      }
      if (event["text"] === "") {
        socket.send(JSON.stringify({ isFinal: true }));
      }
    };

    await bridge.connect();
    expect(state.sttRequests[0]?.apiKey).toBe("test-eleven-key");
    expect(state.sttRequests[0]?.search).toContain("model_id=scribe_v2_realtime");
    expect(state.sttRequests[0]?.search).toContain("audio_format=pcm_24000");
    expect(state.sttRequests[0]?.search).toContain("commit_strategy=vad");
    expect(state.sttRequests[0]?.search).toContain("vad_silence_threshold_secs=0.6");
    expect(emitted).toContainEqual({ type: "voice.state", payload: { state: "connecting" } });
    expect(emitted).toContainEqual({
      type: "voice.state",
      payload: { state: "connected", model: "gpt-5.5", voice: "21m00Tcm4TlvDq8ikWAM" },
    });
    expect(emitted).toContainEqual({ type: "voice.state", payload: { state: "listening" } });

    bridge.appendAudio(new Uint8Array([1, 2, 3, 4]));
    const chunkMessage = await state.until(
      () => state.sttMessages.find((message) => message["message_type"] === "input_audio_chunk"),
    );
    expect(chunkMessage["audio_base_64"]).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(chunkMessage["commit"]).toBe(false);
    expect(chunkMessage["sample_rate"]).toBe(24_000);

    const scribe = state.sttSockets[0];
    if (!scribe) throw new Error("scribe socket missing");
    scribe.send(JSON.stringify({ message_type: "partial_transcript", text: "what is" }));
    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.user_pending"));
    expect(emitted).toContainEqual({
      type: "voice.transcript.user_pending",
      payload: { text: "what is" },
    });

    scribe.send(JSON.stringify({ message_type: "committed_transcript", text: "What is the status?" }));
    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.user"));
    expect(emitted).toContainEqual({
      type: "voice.transcript.user",
      payload: { text: "What is the status?" },
    });
    expect(emitted).toContainEqual({ type: "voice.state", payload: { state: "thinking" } });

    const body = await state.until(() => state.responsesBodies[0]);
    expect(state.responsesAuth[0]).toBe("Bearer test-openai-key");
    expect(body["model"]).toBe("gpt-5.5");
    expect(body["reasoning"]).toEqual({ effort: "none" });
    expect(body["stream"]).toBe(true);
    expect(body["store"]).toBe(false);
    expect(body["instructions"]).toBe("Cascade test instructions.");
    expect(body["tools"]).toEqual(toolkit.tools());
    const input = body["input"];
    if (!Array.isArray(input)) throw new Error("responses input missing");
    const last = input.at(-1);
    if (!isRecord(last)) throw new Error("responses input item malformed");
    expect(last["role"]).toBe("user");
    expect(JSON.stringify(last)).toContain("What is the status?");

    const ttsRequest = await state.until(() => state.ttsRequests[0]);
    expect(ttsRequest.apiKey).toBe("test-eleven-key");
    expect(ttsRequest.path).toContain("/tts/21m00Tcm4TlvDq8ikWAM/stream-input");
    expect(ttsRequest.path).toContain("model_id=eleven_flash_v2_5");
    expect(ttsRequest.path).toContain("output_format=pcm_24000");
    expect(ttsRequest.path).toContain("auto_mode=true");
    expect(ttsRequest.path).toContain("sync_alignment=true");

    await state.until(() => state.ttsMessages.length >= 4 || undefined);
    expect(state.ttsMessages[0]).toEqual({ text: " " });
    // Sentence completed mid-stream, sub-sentence tail flushed at turn end.
    expect(state.ttsMessages.slice(1, 3)).toEqual([
      { text: "Hello there. " },
      { text: "More soon " },
    ]);
    expect(state.ttsMessages.at(-1)).toEqual({ text: "" });

    await state.until(() => audio.length >= 2 || undefined);
    expect(audio[0]?.pcm.byteLength).toBe(4_800);
    const itemId = audio[0]?.playback.itemId;
    if (!itemId) throw new Error("playback itemId missing");
    expect(audio.every((entry) => entry.playback.itemId === itemId)).toBe(true);
    expect(audio.every((entry) => entry.playback.contentIndex === 0)).toBe(true);
    expect(emitted).toContainEqual({ type: "voice.audio", payload: { itemId, contentIndex: 0 } });
    expect(emitted).toContainEqual({ type: "voice.state", payload: { state: "speaking" } });

    const deltas = emitted.flatMap((entry) =>
      entry.type === "voice.transcript.assistant_delta" &&
      isRecord(entry.payload) && typeof entry.payload["text"] === "string"
        ? [entry.payload["text"]]
        : [],
    );
    expect(deltas).toEqual(["Hello the", "re. ", "More soon"]);
    expect(emitted).toContainEqual({
      type: "voice.transcript.assistant",
      payload: { text: "Hello there. More soon" },
    });

    await state.until(() => {
      const speakingIndex = emitted.findIndex((entry) => stateOf(entry) === "speaking");
      if (speakingIndex === -1) return undefined;
      return emitted.slice(speakingIndex).find((entry) => stateOf(entry) === "listening");
    });

    await bridge.disconnect();
    expect(toolkit.cleared).toContain("voice_disconnected");
    expect(emitted).toContainEqual({ type: "voice.state", payload: { state: "disconnected" } });
  });

  test("runs a function_call round-trip through the injected toolkit", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit({ status: "ok", taskState: "running" });
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    state.responseQueue.push(() => sse([
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "get_task_status",
          arguments: "{\"taskId\":\"task-1\"}",
        },
      },
      { type: "response.completed", response: {} },
    ]));
    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "The task is still running." },
      { type: "response.completed", response: {} },
    ]));
    state.onTtsMessage = (socket, event) => {
      if (event["text"] === "") socket.send(JSON.stringify({ isFinal: true }));
    };

    await bridge.connect();
    bridge.sendText("How is the task doing?");

    const secondBody = await state.until(() => state.responsesBodies[1]);
    expect(toolkit.executed).toEqual([{ name: "get_task_status", input: { taskId: "task-1" } }]);
    const input = secondBody["input"];
    if (!Array.isArray(input)) throw new Error("chained input missing");
    const callItem = input.find((item) => isRecord(item) && item["type"] === "function_call");
    if (!isRecord(callItem)) throw new Error("function_call item missing from chained input");
    expect(callItem["call_id"]).toBe("call_1");
    expect(callItem["name"]).toBe("get_task_status");
    const outputItem = input.find((item) => isRecord(item) && item["type"] === "function_call_output");
    if (!isRecord(outputItem)) throw new Error("function_call_output item missing from chained input");
    expect(outputItem["call_id"]).toBe("call_1");
    expect(outputItem["output"]).toBe(JSON.stringify({ status: "ok", taskState: "running" }));

    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.assistant"));
    expect(emitted).toContainEqual({
      type: "voice.transcript.assistant",
      payload: { text: "The task is still running." },
    });
  });

  test("barge-in truncates assistant history using chunk-relative alignment", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "Hello!" },
      { type: "response.completed", response: {} },
    ]));
    // 14_400 bytes of 24kHz int16 mono PCM = 300ms per chunk. Alignment times
    // are chunk-relative, so chunk two's chars start at absolute 300ms.
    const chunk = Buffer.alloc(14_400, 7).toString("base64");
    state.onTtsMessage = (socket, event) => {
      // "Hello!" is below the min sentence size, so it arrives as the
      // normalized end-of-turn flush.
      if (event["text"] === "Hello! ") {
        socket.send(JSON.stringify({
          audio: chunk,
          alignment: { chars: ["H", "e", "l"], charStartTimesMs: [0, 100, 200], charDurationsMs: [100, 100, 100] },
        }));
        socket.send(JSON.stringify({
          audio: chunk,
          alignment: { chars: ["l", "o", "!"], charStartTimesMs: [0, 100, 200], charDurationsMs: [100, 100, 100] },
        }));
      }
      if (event["text"] === "") socket.send(JSON.stringify({ isFinal: true }));
    };

    await bridge.connect();
    bridge.sendText("Greet me");

    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.assistant"));
    // Both chunks must land before the barge-in so the alignment timeline is
    // complete; interrupting sooner is valid but tests less.
    await state.until(() => audio.length >= 2 || undefined);
    const itemId = await state.until(() => audio[0]?.playback.itemId);

    // Absolute char starts: H=0 e=100 l=200 | l=300 o=400 !=500. The user
    // heard through 350ms, so only "Hell" survives in history.
    bridge.interrupt({ itemId, contentIndex: 0, audioEndMs: 350 });
    expect(emitted).toContainEqual({ type: "voice.interrupt", payload: {} });
    expect(emitted).toContainEqual({ type: "voice.state", payload: { state: "listening" } });

    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "Again." },
      { type: "response.completed", response: {} },
    ]));
    bridge.sendText("Continue");
    const secondBody = await state.until(() => state.responsesBodies[1]);
    const input = secondBody["input"];
    if (!Array.isArray(input)) throw new Error("post-interrupt input missing");
    const assistantItems = input.filter((item) =>
      isRecord(item) && item["type"] === "message" && item["role"] === "assistant",
    );
    expect(assistantItems).toHaveLength(1);
    expect(JSON.stringify(assistantItems[0])).toContain("\"text\":\"Hell\"");
    expect(JSON.stringify(assistantItems[0])).not.toContain("Hello!");
  });

  test("assembles token deltas into sentence chunks for TTS", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "I " },
      { type: "response.output_text.delta", delta: "think " },
      { type: "response.output_text.delta", delta: "3.14 " },
      { type: "response.output_text.delta", delta: "is " },
      { type: "response.output_text.delta", delta: "neat. " },
      { type: "response.output_text.delta", delta: "Also " },
      { type: "response.output_text.delta", delta: "yes! " },
      { type: "response.output_text.delta", delta: "Bye" },
      { type: "response.completed", response: {} },
    ]));
    state.onTtsMessage = (socket, event) => {
      if (event["text"] === "") socket.send(JSON.stringify({ isFinal: true }));
    };

    await bridge.connect();
    bridge.sendText("Say something");
    await state.until(
      () => state.ttsMessages.find((message) => message["text"] === ""),
    );

    // One frame per prosody unit: decimals never split a sentence, the short
    // trailing sentence merges with the tail flush, and no token-sized
    // fragment ever reaches the TTS socket (the word-by-word regression).
    expect(state.ttsMessages).toEqual([
      { text: " " },
      { text: "I think 3.14 is neat. " },
      { text: "Also yes! Bye " },
      { text: "" },
    ]);
  });

  test("screenshots attach for one turn then detach from history", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    // Mirrors look_at_screen: the executor pushes pixels through the host.
    toolkit.execute = async (name, input) => {
      toolkit.executed.push({ name, input });
      toolkit.host?.attachUserImage("Inspect this image now.", "data:image/png;base64,QUJD");
      return { visualInputAttached: true };
    };
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    state.responseQueue.push(() => sse([
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_see_1",
          name: "look_at_screen",
          arguments: "{}",
        },
      },
      { type: "response.completed", response: {} },
    ]));
    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "I can see the board now." },
      { type: "response.completed", response: {} },
    ]));
    state.onTtsMessage = (socket, event) => {
      if (event["text"] === "") socket.send(JSON.stringify({ isFinal: true }));
    };

    await bridge.connect();
    bridge.sendText("Look at my screen");

    // The tool round attaches the image; the follow-up request must carry it.
    const secondBody = await state.until(() => state.responsesBodies[1]);
    const withImage = JSON.stringify(secondBody["input"]);
    expect(withImage).toContain("\"type\":\"input_image\"");
    expect(withImage).toContain("data:image/png;base64,QUJD");
    expect(withImage).toContain("\"detail\":\"high\"");

    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.assistant"));

    // Next turn: the image is detached so it never rides future requests.
    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "Next." },
      { type: "response.completed", response: {} },
    ]));
    bridge.sendText("Continue");
    const thirdBody = await state.until(() => state.responsesBodies[2]);
    const detached = JSON.stringify(thirdBody["input"]);
    expect(detached).not.toContain("input_image");
    expect(detached).not.toContain("QUJD");
    expect(detached).toContain("detached");
  });

  test("text mode skips TTS entirely", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "Typed answer." },
      { type: "response.completed", response: {} },
    ]));
    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "Second." },
      { type: "response.completed", response: {} },
    ]));

    await bridge.connect();
    bridge.setResponseMode("text");
    expect(emitted).toContainEqual({ type: "voice.mode", payload: { mode: "text" } });

    bridge.sendText("Answer in text");
    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.assistant"));
    expect(emitted).toContainEqual({
      type: "voice.transcript.assistant_delta",
      payload: { text: "Typed answer." },
    });
    expect(emitted).toContainEqual({
      type: "voice.transcript.assistant",
      payload: { text: "Typed answer." },
    });

    // A second full round-trip guarantees any stray TTS upgrade from the
    // first turn would have reached the server by now.
    bridge.sendText("And again");
    await state.until(() => state.responsesBodies[1]);
    await state.until(() =>
      emitted.filter((entry) => entry.type === "voice.transcript.assistant")[1],
    );
    expect(state.ttsRequests).toHaveLength(0);
    expect(audio).toHaveLength(0);
    expect(emitted.some((entry) => stateOf(entry) === "speaking")).toBe(false);
  });

  test("queues briefs while disengaged and flushes them once on re-engage", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const queuedBriefs: string[] = [];
    const deliveredBriefs: string[][] = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio, {
      initiallyEngaged: false,
      onBriefQueued: (brief) => {
        queuedBriefs.push(brief.taskId);
      },
      onBriefDelivered: (taskIds) => {
        deliveredBriefs.push([...taskIds]);
      },
    });
    const state = providers;

    await bridge.connect();
    expect(state.sttSockets).toHaveLength(0);

    const taskId = Bun.randomUUIDv7();
    bridge.handleTaskEvents([
      makeEvent("task.completed", taskId, {
        runId: Bun.randomUUIDv7(),
        summary: "Voice cascade shipped.",
        evidenceIds: [],
      }),
    ]);
    expect(queuedBriefs).toEqual([taskId]);
    expect(emitted).toContainEqual({
      type: "brief.queued",
      payload: { taskId, kind: "completed", summary: "Voice cascade shipped.", pending: 1 },
    });
    expect(emitted.some((entry) => entry.type === "voice.notification")).toBe(true);
    expect(state.responsesBodies).toHaveLength(0);

    state.responseQueue.push(() => sse([
      { type: "response.output_text.delta", delta: "Your task finished." },
      { type: "response.completed", response: {} },
    ]));
    state.onTtsMessage = (socket, event) => {
      if (event["text"] === "") socket.send(JSON.stringify({ isFinal: true }));
    };

    bridge.setEngaged(true);
    expect(emitted).toContainEqual({ type: "voice.engaged", payload: { pendingBrief: true } });

    const body = await state.until(() => state.responsesBodies[0]);
    const serialized = JSON.stringify(body["input"]);
    expect(serialized).toContain("Mamachi resumed after sleeping");
    expect(serialized).toContain("Voice cascade shipped.");
    expect(deliveredBriefs).toEqual([[taskId]]);
    expect(emitted).toContainEqual({ type: "brief.delivered", payload: { count: 1 } });
    await state.until(() => state.sttSockets[0]);

    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.assistant"));
    bridge.setEngaged(false);
    bridge.setEngaged(true);
    // Brief flushing is synchronous inside setEngaged: with an empty queue no
    // request can be in flight, so this assertion cannot race.
    expect(deliveredBriefs).toEqual([[taskId]]);
    expect(state.responsesBodies).toHaveLength(1);
  });

  test("scribe auth_error is fatal: error state, no reconnect", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    await bridge.connect();
    const scribe = await state.until(() => state.sttSockets[0]);

    scribe.send(JSON.stringify({ message_type: "rate_limited", error: "slow down" }));
    await state.until(() => emitted.find((entry) => entry.type === "voice.error"));
    expect(emitted).toContainEqual({
      type: "voice.error",
      payload: { error: "slow down", recoverable: true },
    });
    expect(emitted.some((entry) => stateOf(entry) === "error")).toBe(false);

    // A pending partial makes the bridge-side socket close observable: the
    // close handler discards it, proving the no-reconnect branch already ran.
    scribe.send(JSON.stringify({ message_type: "partial_transcript", text: "hel" }));
    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.user_pending"));
    scribe.send(JSON.stringify({ message_type: "auth_error", error: "invalid api key" }));
    await state.until(() => emitted.find((entry) => stateOf(entry) === "error"));
    expect(emitted).toContainEqual({ type: "voice.error", payload: { error: "invalid api key" } });
    await state.until(() => emitted.find((entry) => entry.type === "voice.transcript.user_discarded"));

    expect(state.sttRequests).toHaveLength(1);
    expect(emitted.some(
      (entry) => entry.type === "voice.state" &&
        isRecord(entry.payload) && entry.payload["reason"] === "provider_reconnecting",
    )).toBe(false);
  });

  test("scribe drop while engaged reconnects with bounded backoff", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const audio: Array<{ pcm: Uint8Array; playback: { itemId: string; contentIndex: number } }> = [];
    const bridge = bridgeFor(providers, toolkit, emitted, audio);
    const state = providers;

    await bridge.connect();
    const scribe = await state.until(() => state.sttSockets[0]);
    scribe.close(1006, "simulated drop");

    await state.until(() => state.sttSockets[1]);
    expect(emitted).toContainEqual({
      type: "voice.state",
      payload: { state: "connecting", reason: "provider_reconnecting", attempt: 1, retryInMs: 10 },
    });
    await state.until(() => {
      const reconnectIndex = emitted.findIndex(
        (entry) => entry.type === "voice.state" &&
          isRecord(entry.payload) && entry.payload["reason"] === "provider_reconnecting",
      );
      if (reconnectIndex === -1) return undefined;
      return emitted.slice(reconnectIndex + 1).find((entry) => stateOf(entry) === "listening");
    });

    await bridge.disconnect();
    expect(emitted).toContainEqual({ type: "voice.state", payload: { state: "disconnected" } });
  });

  test("delegates harness notes and computer-control refresh to the toolkit", async () => {
    providers = startProviders();
    const toolkit = createFakeToolkit();
    const emitted: Emitted[] = [];
    const bridge = bridgeFor(providers, toolkit, emitted, []);

    bridge.noteHarnessEvent("tool.used", { taskId: "task-1", toolName: "bash" });
    expect(toolkit.harnessNotes).toEqual([{ type: "tool.used", payload: { taskId: "task-1", toolName: "bash" } }]);

    bridge.refreshComputerControlConfiguration();
    expect(toolkit.cleared).toContain("settings_changed");

    expect(toolkit.host).not.toBeNull();
    expect(toolkit.host?.isEngaged()).toBe(true);
    expect(toolkit.host?.getResponseMode()).toBe("voice");
  });
});
