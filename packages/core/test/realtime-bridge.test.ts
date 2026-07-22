import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import type { ActionResult } from "@mamachi/protocol";
import { RealtimeBridge } from "../src/realtime-bridge.ts";
import type { ControllerSnapshot } from "../src/domain.ts";

interface MockClientData {
  authenticated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


describe("RealtimeBridge", () => {
  let server: Server<MockClientData> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("configures duplex audio and executes strict task tools", async () => {
    const incoming: Record<string, unknown>[] = [];
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const audio: Uint8Array[] = [];
    const commands: unknown[] = [];
    let client: ServerWebSocket<MockClientData> | undefined;
    let sawAuthorization = false;
    const contextReceived = Promise.withResolvers<void>();
    const textReceived = Promise.withResolvers<void>();
    const commandExecuted = Promise.withResolvers<void>();
    const functionOutputReceived = Promise.withResolvers<void>();
    const audioForwarded = Promise.withResolvers<void>();
    const transcriptReceived = Promise.withResolvers<void>();
    const manualResponseReceived = Promise.withResolvers<void>();
    let awaitingManualResponse = false;

    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        sawAuthorization = request.headers.get("authorization") === "Bearer test-realtime-key";
        const upgraded = bunServer.upgrade(request, { data: { authenticated: sawAuthorization } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          incoming.push(event);
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_test" } }));
          }
          const serialized = JSON.stringify(event);
          if (serialized.includes("explicitly captured editor context")) contextReceived.resolve();
          if (serialized.includes("Update the selected function")) textReceived.resolve();
          if (serialized.includes("call_submit_1") && serialized.includes("function_call_output")) {
            functionOutputReceived.resolve();
          }
          if (awaitingManualResponse && event["type"] === "response.create") manualResponseReceived.resolve();
        },
      },
    });

    const snapshot: ControllerSnapshot = {
      seq: 0,
      activeTaskId: null,
      queue: [],
      tasks: [],
      runs: [],
    };
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => snapshot,
      executeCommand: async (command): Promise<ActionResult> => {
        commands.push(command);
        commandExecuted.resolve();
        return {
          status: "accepted",
          eventId: Bun.randomUUIDv7(),
          taskId: Bun.randomUUIDv7(),
        };
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "voice.transcript.assistant") transcriptReceived.resolve();
      },
      emitAudio: (pcm) => {
        audio.push(pcm);
        audioForwarded.resolve();
      },
    });

    bridge.captureContext({
      id: Bun.randomUUIDv7(),
      kind: "selection",
      workspace: "/tmp/mamachi-workspace",
      summary: "Explicit selection: math.ts",
      payload: { path: "math.ts", selection: "return 1" },
      createdAt: new Date().toISOString(),
    });
    await bridge.connect();
    await contextReceived.promise;

    expect(sawAuthorization).toBe(true);
    const update = incoming.find((event) => event["type"] === "session.update");
    expect(update).toBeDefined();
    const session = update?.["session"] as Record<string, unknown>;
    expect(session["output_modalities"]).toEqual(["audio"]);
    expect(session["parallel_tool_calls"]).toBe(false);
    expect(session["audio"]).toMatchObject({
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        turn_detection: { type: "server_vad", create_response: false, interrupt_response: true },
      },
      output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
    });
    expect((session["tools"] as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      "submit_task",
      "get_task_status",
      "control_task",
      "revise_task",
      "get_workspace",
      "wait_for_user",
    ]);
    expect(
      incoming.some(
        (event) =>
          event["type"] === "conversation.item.create" &&
          JSON.stringify(event).includes("explicitly captured editor context"),
      ),
    ).toBe(true);

    bridge.sendText("Update the selected function");
    await textReceived.promise;
    expect(
      incoming.some(
        (event) => event["type"] === "conversation.item.create" && JSON.stringify(event).includes("Update the selected function"),
      ),
    ).toBe(true);

    const callId = "call_submit_1";
    client?.send(
      JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: callId,
              name: "submit_task",
              arguments: JSON.stringify({
                objective: "Update the selected function",
                acceptanceCriteria: ["The function returns two"],
                constraints: ["Change only the selected file"],
              }),
            },
          ],
        },
      }),
    );
    await commandExecuted.promise;
    const submitted = commands[0] as { type: string; payload: { attachmentIds: string[] } };
    expect(submitted.type).toBe("task.submit");
    expect(submitted.payload.attachmentIds).toHaveLength(1);
    await functionOutputReceived.promise;

    client?.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
    );
    client?.send(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Task started." }));
    await audioForwarded.promise;
    await transcriptReceived.promise;
    expect([...audio[0]!]).toEqual([1, 2, 3, 4]);
    expect(emitted).toContainEqual({ type: "voice.transcript.assistant", payload: { text: "Task started." } });

    client?.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
    awaitingManualResponse = true;
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    await manualResponseReceived.promise;

    await bridge.disconnect();
    expect(emitted.at(-1)).toEqual({ type: "voice.state", payload: { state: "disconnected" } });
  });

  test("wait_for_user ends the response chain", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    const idle = Promise.withResolvers<void>();
    const functionOutput = Promise.withResolvers<void>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_wait" } }));
          }
          if (
            event["type"] === "conversation.item.create" &&
            JSON.stringify(event).includes("call_wait")
          ) {
            functionOutput.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [] }),
      executeCommand: async () => {
        throw new Error("wait_for_user must not execute a coding command");
      },
      emit: (type, payload) => {
        if (type === "voice.state" && isRecord(payload) && payload["state"] === "idle") idle.resolve();
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Hello");
    client?.send(
      JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_wait",
              name: "wait_for_user",
              arguments: "{}",
            },
          ],
        },
      }),
    );

    await Promise.all([functionOutput.promise, idle.promise]);
    await bridge.disconnect();
  });

  test("stops a runaway voice tool chain after four rounds", async () => {
    let responseRounds = 0;
    const guardError = Promise.withResolvers<string>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_guard" } }));
          } else if (event["type"] === "response.create" && responseRounds < 4) {
            responseRounds += 1;
            socket.send(
              JSON.stringify({
                type: "response.done",
                response: {
                  status: "completed",
                  output: [
                    {
                      type: "function_call",
                      call_id: `call_status_${responseRounds}`,
                      name: "get_workspace",
                      arguments: "{}",
                    },
                  ],
                },
              }),
            );
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [] }),
      executeCommand: async () => {
        throw new Error("get_workspace must not execute a coding command");
      },
      emit: (type, payload) => {
        if (type === "voice.error" && isRecord(payload) && typeof payload["error"] === "string") {
          guardError.resolve(payload["error"]);
        }
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Loop forever");

    await expect(guardError.promise).resolves.toContain("four consecutive tool rounds");
    expect(responseRounds).toBe(4);
    await bridge.disconnect();
  });

  test("starts a fresh response after the user barges in", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    let responseCreates = 0;
    const initialResponse = Promise.withResolvers<void>();
    const resumedResponse = Promise.withResolvers<void>();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const audio: Uint8Array[] = [];
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_barge" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) initialResponse.resolve();
            if (responseCreates === 2) resumedResponse.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [] }),
      executeCommand: async () => {
        throw new Error("barge-in must not execute a coding command");
      },
      emit: (type, payload) => emitted.push({ type, payload }),
      emitAudio: (pcm) => audio.push(pcm),
    });

    await bridge.connect();
    bridge.sendText("Start a long answer");
    await initialResponse.promise;
    client?.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.from([1, 2]).toString("base64"),
      }),
    );
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    client?.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.from([3, 4]).toString("base64"),
      }),
    );
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client?.send(JSON.stringify({ type: "response.done", response: { status: "cancelled", output: [] } }));

    await resumedResponse.promise;
    expect(responseCreates).toBe(2);
    expect(audio.map((pcm) => [...pcm])).toEqual([[1, 2]]);
    expect(emitted).toContainEqual({ type: "voice.interrupt", payload: {} });
    await bridge.disconnect();
  });
});
