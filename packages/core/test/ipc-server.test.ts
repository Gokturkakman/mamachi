import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MamachiIpcServer } from "../src/ipc-server.ts";
import type { EditorDocumentState } from "../src/workspace-guard.ts";

interface IpcResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function request(socket: WebSocket, type: string, payload: Record<string, unknown>): Promise<IpcResponse> {
  const id = Bun.randomUUIDv7();
  const { promise, resolve, reject } = Promise.withResolvers<IpcResponse>();
  const onMessage = (data: WebSocket.RawData): void => {
    const message = JSON.parse(data.toString()) as { type?: unknown; payload?: unknown };
    if (message.type !== "response" || typeof message.payload !== "object" || message.payload === null) return;
    const response = message.payload as IpcResponse;
    if (response.requestId !== id) return;
    socket.off("message", onMessage);
    resolve(response);
  };
  socket.on("message", onMessage);
  socket.once("error", reject);
  socket.send(JSON.stringify({ version: 1, id, type, payload }));
  return promise;
}

test("IPC forwards strict editor state without document content", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-editor-"));
  const path = join(workspace, "feature.ts");
  const canonicalWorkspace = realpathSync(workspace);
  const canonicalPath = join(canonicalWorkspace, "feature.ts");
  writeFileSync(path, "export {};\n");
  const editorStates: EditorDocumentState[] = [];
  const server = new MamachiIpcServer({
    token: "editor-test-token",
    port: 0,
    initialWorkspace: workspace,
    hooks: { onEditorState: (state) => editorStates.push(state) },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer editor-test-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const accepted = await request(socket, "editor.state", {
      workspace,
      path,
      version: 7,
      dirty: true,
      open: true,
    });
    expect(accepted).toMatchObject({ ok: true, result: { accepted: true } });
    expect(editorStates).toEqual([
      { workspace: canonicalWorkspace, path: canonicalPath, version: 7, dirty: true, open: true },
    ]);

    const rejected = await request(socket, "editor.state", {
      workspace,
      path,
      version: 8,
      dirty: false,
      open: true,
      content: "must never cross this boundary",
    });
    expect(rejected).toMatchObject({ ok: false, error: "editor.state payload is invalid" });
    expect(editorStates).toHaveLength(1);
  } finally {
    socket.close();
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("IPC removes captured context through the hook and broadcasts context.removed", async () => {
  const removed: string[] = [];
  const server = new MamachiIpcServer({
    token: "context-remove-token",
    port: 0,
    hooks: { onContextRemoved: (id) => removed.push(id) },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer context-remove-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const broadcasts: unknown[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: unknown; payload?: unknown };
      if (message.type === "context.removed") broadcasts.push(message.payload);
    });

    const accepted = await request(socket, "context.remove", { id: "ctx_1" });
    expect(accepted).toMatchObject({ ok: true, result: { removed: true } });
    expect(removed).toEqual(["ctx_1"]);
    expect(broadcasts).toEqual([{ ids: ["ctx_1"] }]);

    const missingId = await request(socket, "context.remove", {});
    expect(missingId).toMatchObject({ ok: false, error: "context.remove requires one id string" });
    const wrongType = await request(socket, "context.remove", { id: 7 });
    expect(wrongType.ok).toBe(false);
    const extraKey = await request(socket, "context.remove", { id: "ctx_2", purge: true });
    expect(extraKey.ok).toBe(false);
    expect(removed).toEqual(["ctx_1"]);
    expect(broadcasts).toEqual([{ ids: ["ctx_1"] }]);
  } finally {
    socket.close();
    server.close();
  }
});

test("IPC validates voice engagement and forwards the playback cursor", async () => {
  const engagements: Array<{ engaged: boolean; playback: unknown }> = [];
  const server = new MamachiIpcServer({
    token: "engagement-token",
    port: 0,
    hooks: { onVoiceEngagement: (engaged, playback) => engagements.push({ engaged, playback }) },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer engagement-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const engagedOnly = await request(socket, "voice.engagement", { engaged: true });
    expect(engagedOnly).toMatchObject({ ok: true, result: { engaged: true } });
    const withPlayback = await request(socket, "voice.engagement", {
      engaged: false,
      playback: { itemId: "item_9", contentIndex: 0, audioEndMs: 1200 },
    });
    expect(withPlayback).toMatchObject({ ok: true, result: { engaged: false } });
    expect(engagements).toEqual([
      { engaged: true, playback: null },
      { engaged: false, playback: { itemId: "item_9", contentIndex: 0, audioEndMs: 1200 } },
    ]);

    const missing = await request(socket, "voice.engagement", {});
    expect(missing).toMatchObject({ ok: false, error: "voice.engagement payload is invalid" });
    const wrongType = await request(socket, "voice.engagement", { engaged: "yes" });
    expect(wrongType.ok).toBe(false);
    const badCursor = await request(socket, "voice.engagement", { engaged: true, playback: { itemId: "" } });
    expect(badCursor).toMatchObject({ ok: false, error: "Playback cursor is invalid" });
    const extraKey = await request(socket, "voice.engagement", { engaged: true, mode: "voice" });
    expect(extraKey.ok).toBe(false);
    expect(engagements).toHaveLength(2);
  } finally {
    socket.close();
    server.close();
  }
});

test("IPC rejects task attachments that are missing from the selected workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-attachment-"));
  const server = new MamachiIpcServer({
    token: "attachment-test-token",
    port: 0,
    initialWorkspace: workspace,
  });
  try {
    const result = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(workspace),
        objective: "Use the captured editor selection",
        acceptanceCriteria: ["The selected behavior is implemented"],
        constraints: [],
        attachmentIds: [Bun.randomUUIDv7()],
        codingProfileId: null,
      },
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "attachment_mismatch",
    });
    expect(server.snapshot().tasks).toEqual([]);
  } finally {
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("IPC correlates explicit editor capture requests and reports timeout without silent capture", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-voice-capture-"));
  const path = join(workspace, "feature.ts");
  writeFileSync(path, "export const value = 1;\n");
  const server = new MamachiIpcServer({
    token: "voice-capture-token",
    port: 0,
    initialWorkspace: workspace,
    editorContextTimeoutMs: 20,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer voice-capture-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const responseSent = Promise.withResolvers<void>();
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: unknown; payload?: unknown };
      if (message.type !== "editor.context.request" || typeof message.payload !== "object" || message.payload === null) return;
      const payload = message.payload as { requestId: string };
      void request(socket, "editor.context.response", {
        requestId: payload.requestId,
        captures: [{ kind: "selection", payload: { path, language: "typescript", selection: "value = 1" } }],
        errors: [],
      }).then(() => responseSent.resolve());
    });
    const captured = await server.captureEditorContext(["selection"]);
    await responseSent.promise;
    expect(captured.errors).toEqual([]);
    expect(captured.artifacts).toHaveLength(1);
    expect(server.getArtifacts([captured.artifacts[0]!.id])[0]?.payload["selection"]).toBe("value = 1");

    const stale = await request(socket, "editor.context.response", {
      requestId: "stale-request",
      captures: [],
      errors: [],
    });
    expect(stale).toMatchObject({ ok: false, error: "Editor context response is stale or does not match the request" });
  } finally {
    socket.close();
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }

  const timeoutWorkspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-voice-timeout-"));
  const timeoutServer = new MamachiIpcServer({
    token: "voice-timeout-token",
    port: 0,
    initialWorkspace: timeoutWorkspace,
    editorContextTimeoutMs: 5,
  });
  try {
    await expect(timeoutServer.captureEditorContext(["diagnostics"])).rejects.toThrow(
      "No connected VS Code client can capture editor context",
    );
  } finally {
    timeoutServer.close();
    rmSync(timeoutWorkspace, { recursive: true, force: true });
  }
});

test("IPC artifact getters enforce task ownership", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-artifact-owner-"));
  const server = new MamachiIpcServer({
    token: "artifact-owner-token",
    port: 0,
    initialWorkspace: workspace,
  });
  try {
    const submitted = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(workspace),
        objective: "Change a file",
        acceptanceCriteria: ["The change is verified"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    });
    if (submitted.status !== "accepted" || !submitted.taskId) throw new Error("Task submission failed");
    const task = server.snapshot().tasks.find((candidate) => candidate.id === submitted.taskId);
    if (!task?.activeRunId) throw new Error("Task did not start");
    const artifact = await server.recordToolEvidence({
      taskId: task.id,
      runId: task.activeRunId,
      repository: workspace,
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: "bun test focused" },
      result: "passed",
      isError: false,
    });
    expect(server.getTaskArtifact(task.id, artifact.id)?.id).toBe(artifact.id);
    expect(server.getTaskArtifact("different-task", artifact.id)).toBeNull();
    expect(server.getTaskArtifact(task.id, "missing-artifact")).toBeNull();
  } finally {
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

function submitPayload(repositoryId: string, objective: string) {
  return {
    repositoryId,
    objective,
    acceptanceCriteria: ["The change is verified"],
    constraints: [],
    attachmentIds: [],
    codingProfileId: null,
  };
}

test("IPC selects workspaces additively and accepts task.submit for any selected repository", async () => {
  const repoA = mkdtempSync(join(tmpdir(), "mamachi-ipc-repo-a-"));
  const repoB = mkdtempSync(join(tmpdir(), "mamachi-ipc-repo-b-"));
  const server = new MamachiIpcServer({ token: "multi-repo-token", port: 0, initialWorkspace: repoA });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer multi-repo-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    expect(server.selectedWorkspaces).toEqual([realpathSync(repoA)]);

    const beforeSelect = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: submitPayload(realpathSync(repoB), "Work only possible once repo B is selected"),
    });
    expect(beforeSelect).toMatchObject({ status: "rejected", code: "workspace_mismatch" });

    const selected = await request(socket, "workspace.select", { path: repoB });
    expect(selected.ok).toBe(true);
    expect([...server.selectedWorkspaces].sort()).toEqual([realpathSync(repoA), realpathSync(repoB)].sort());

    const inRepoA = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: submitPayload(realpathSync(repoA), "Change repo A"),
    });
    const inRepoB = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: submitPayload(realpathSync(repoB), "Change repo B"),
    });
    expect(inRepoA.status).toBe("accepted");
    expect(inRepoB.status).toBe("accepted");
    expect(server.snapshot().tasks.map((task) => task.repositoryId).sort()).toEqual(
      [realpathSync(repoA), realpathSync(repoB)].sort(),
    );
  } finally {
    socket.close();
    server.close();
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("IPC deselects a workspace, refuses further submissions to it, and keeps at least one selected", async () => {
  const repoA = mkdtempSync(join(tmpdir(), "mamachi-ipc-deselect-a-"));
  const repoB = mkdtempSync(join(tmpdir(), "mamachi-ipc-deselect-b-"));
  const server = new MamachiIpcServer({ token: "deselect-token", port: 0, initialWorkspace: repoA });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer deselect-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    await request(socket, "workspace.select", { path: repoB });
    expect(server.selectedWorkspaces).toHaveLength(2);

    const rejectedLastOne = await request(socket, "workspace.deselect", { path: repoA });
    expect(rejectedLastOne.ok).toBe(true);
    expect(server.selectedWorkspaces).toEqual([realpathSync(repoB)]);

    const afterDeselect = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: submitPayload(realpathSync(repoA), "No longer selected"),
    });
    expect(afterDeselect).toMatchObject({ status: "rejected", code: "workspace_mismatch" });

    const refusesLastWorkspace = await request(socket, "workspace.deselect", { path: repoB });
    expect(refusesLastWorkspace).toMatchObject({
      ok: false,
      error: "At least one workspace must remain selected",
    });
    expect(server.selectedWorkspaces).toEqual([realpathSync(repoB)]);
  } finally {
    socket.close();
    server.close();
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});
