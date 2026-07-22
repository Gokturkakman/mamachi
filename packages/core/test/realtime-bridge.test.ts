import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
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
    const session = update?.["session"];
    if (!isRecord(session)) throw new Error("session.update did not include a session object");
    expect(session["output_modalities"]).toEqual(["audio"]);
    expect(session["parallel_tool_calls"]).toBe(false);
    expect(session["audio"]).toMatchObject({
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        turn_detection: { type: "server_vad", create_response: false, interrupt_response: true },
      },
      output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
    });
    const tools = session["tools"];
    expect(Array.isArray(tools) ? tools.map((tool) => isRecord(tool) ? tool["name"] : null) : []).toEqual([
      "submit_task",
      "get_task_status",
      "control_task",
      "revise_task",
      "inspect_workspace",
      "research_web",
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

  test("ignores a raced cancel error and continues the interrupted turn", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    let responseCreates = 0;
    const firstResponse = Promise.withResolvers<void>();
    const cancelReceived = Promise.withResolvers<void>();
    const resumedResponse = Promise.withResolvers<void>();
    const errors: string[] = [];
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
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_cancel_race" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) firstResponse.resolve();
            if (responseCreates === 2) resumedResponse.resolve();
          } else if (event["type"] === "response.cancel") {
            cancelReceived.resolve();
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
        throw new Error("cancel race must not execute a coding command");
      },
      emit: (type, payload) => {
        if (type === "voice.error" && isRecord(payload) && typeof payload["error"] === "string") {
          errors.push(payload["error"]);
        }
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Start answering");
    await firstResponse.promise;
    bridge.interrupt();
    await cancelReceived.promise;
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client?.send(
      JSON.stringify({
        type: "error",
        error: { message: "Cancellation failed: no active response found" },
      }),
    );

    await resumedResponse.promise;
    expect(responseCreates).toBe(2);
    expect(errors).toEqual([]);
    await bridge.disconnect();
  });

  test("switches future responses to silent text without cutting the active response", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    const updates: Record<string, unknown>[] = [];
    let responseCreates = 0;
    const firstResponse = Promise.withResolvers<void>();
    const modeUpdated = Promise.withResolvers<void>();
    const textReceived = Promise.withResolvers<void>();
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
            updates.push(event);
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_text" } }));
            if (updates.length === 2) modeUpdated.resolve();
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              firstResponse.resolve();
            } else {
              socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Silent " }));
              socket.send(JSON.stringify({ type: "response.output_text.done", text: "Silent response" }));
              socket.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
            }
          }
        },
      },
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const audio: Uint8Array[] = [];
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [] }),
      executeCommand: async () => {
        throw new Error("text chat must not execute a coding command");
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "voice.transcript.assistant") textReceived.resolve();
      },
      emitAudio: (pcm) => audio.push(pcm),
    });

    await bridge.connect();
    bridge.sendText("Start a voice response");
    await firstResponse.promise;
    expect(updates).toHaveLength(1);
    bridge.setResponseMode("text");
    expect(updates).toHaveLength(1);
    client?.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
    await modeUpdated.promise;
    bridge.sendText("Reply silently");
    await textReceived.promise;

    const latestSession = updates.at(-1)?.["session"];
    expect(isRecord(latestSession) ? latestSession["output_modalities"] : null).toEqual(["text"]);
    expect(emitted).toContainEqual({ type: "voice.transcript.assistant", payload: { text: "Silent response" } });
    expect(audio).toEqual([]);
    await bridge.disconnect();
    expect(client).toBeDefined();
  });

  test("delegates current web research to a fast coding task", async () => {
    const commands: unknown[] = [];
    let responseCreates = 0;
    const delegated = Promise.withResolvers<void>();
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
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_research" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  response: {
                    status: "completed",
                    output: [{
                      type: "function_call",
                      call_id: "research_call",
                      name: "research_web",
                      arguments: JSON.stringify({
                        query: "confirmed upcoming fixtures",
                        deliverable: "Return a concise fixture list",
                      }),
                    }],
                  },
                }),
              );
            } else {
              delegated.resolve();
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [] }),
      executeCommand: async (command) => {
        commands.push(command);
        return { status: "accepted", eventId: Bun.randomUUIDv7(), taskId: Bun.randomUUIDv7() };
      },
      emit: () => {},
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Find the upcoming fixtures");
    await delegated.promise;

    const command = commands[0];
    expect(isRecord(command) ? command["type"] : null).toBe("task.submit");
    const payload = isRecord(command) ? command["payload"] : null;
    expect(isRecord(payload) ? payload["codingProfileId"] : null).toBe("fast");
    expect(isRecord(payload) ? payload["constraints"] : null).toContain("Research only; do not modify workspace files.");
    await bridge.disconnect();
  });

  test("delegates repository questions to a read-only fast coding task", async () => {
    const commands: unknown[] = [];
    let responseCreates = 0;
    const delegated = Promise.withResolvers<void>();
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
            const session = event["session"];
            expect(isRecord(session) ? session["instructions"] : null).toContain(
              "Any request whose answer depends on current workspace state",
            );
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_inspect" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  response: {
                    status: "completed",
                    output: [{
                      type: "function_call",
                      call_id: "inspect_call",
                      name: "inspect_workspace",
                      arguments: JSON.stringify({
                        question: "What are the latest commits?",
                        deliverable: "Return the five newest commits with hashes and subjects.",
                      }),
                    }],
                  },
                }),
              );
            } else {
              delegated.resolve();
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [] }),
      executeCommand: async (command) => {
        commands.push(command);
        return { status: "accepted", eventId: Bun.randomUUIDv7(), taskId: Bun.randomUUIDv7() };
      },
      emit: () => {},
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("What are the latest commits?");
    await delegated.promise;

    const command = commands[0];
    expect(isRecord(command) ? command["type"] : null).toBe("task.submit");
    const payload = isRecord(command) ? command["payload"] : null;
    expect(isRecord(payload) ? payload["codingProfileId"] : null).toBe("fast");
    expect(isRecord(payload) ? payload["objective"] : null).toContain("What are the latest commits?");
    expect(isRecord(payload) ? payload["constraints"] : null).toContain(
      "Read-only inspection; do not modify workspace files.",
    );
    await bridge.disconnect();
  });

  test("queues a proactive completion announcement behind an active response", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    let responseCreates = 0;
    const injectedItems: Record<string, unknown>[] = [];
    const firstResponse = Promise.withResolvers<void>();
    const proactiveResponse = Promise.withResolvers<void>();
    const announcementSpoken = Promise.withResolvers<void>();
    const completionContextReceived = Promise.withResolvers<void>();
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
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_completion" } }));
          } else if (event["type"] === "conversation.item.create") {
            injectedItems.push(event);
            if (JSON.stringify(event).includes("Proactively tell the user now")) completionContextReceived.resolve();
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              firstResponse.resolve();
            } else {
              proactiveResponse.resolve();
              socket.send(
                JSON.stringify({
                  type: "response.output_audio_transcript.done",
                  transcript: "The coding task finished and all checks passed.",
                }),
              );
              socket.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 7, activeTaskId: null, queue: [], tasks: [], runs: [] }),
      executeCommand: async () => {
        throw new Error("completion announcements must not execute another command");
      },
      emit: (type, payload) => {
        if (type === "voice.transcript.assistant" && isRecord(payload)) announcementSpoken.resolve();
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Tell me something while coding finishes");
    await firstResponse.promise;
    const taskId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    const eventId = Bun.randomUUIDv7();
    const completion: DomainEvent<"task.completed"> = {
      version: 1,
      id: eventId,
      seq: 7,
      at: new Date().toISOString(),
      type: "task.completed",
      actor: "controller",
      taskId,
      runId,
      correlationId: eventId,
      payload: {
        runId,
        summary: "Implemented the requested change; all checks passed.",
        evidenceIds: [],
      },
    };

    bridge.handleTaskEvents([completion]);
    await completionContextReceived.promise;
    expect(responseCreates).toBe(1);
    expect(injectedItems.some((item) => JSON.stringify(item).includes("Proactively tell the user now"))).toBe(true);
    expect(injectedItems.some((item) => JSON.stringify(item).includes("all checks passed"))).toBe(true);
    client?.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
    await proactiveResponse.promise;
    await announcementSpoken.promise;
    expect(responseCreates).toBe(2);
    await bridge.disconnect();
  });
});
