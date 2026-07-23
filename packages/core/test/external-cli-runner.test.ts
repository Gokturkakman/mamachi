import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import type { EvidenceArtifact, ToolEvidenceInput } from "../src/artifact-store.ts";
import type { TaskRecord } from "../src/domain.ts";
import {
  ExternalCliRunner,
  modelForExternalBackend,
  type ExternalCodingBackend,
} from "../src/external-cli-runner.ts";
import { defaultRuntimeSettings } from "../src/model-router.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function accepted(): ActionResult {
  return { status: "accepted", eventId: Bun.randomUUIDv7() };
}

function createTask(repositoryId: string, backend?: ExternalCodingBackend): TaskRecord {
  const id = Bun.randomUUIDv7();
  const runId = Bun.randomUUIDv7();
  return {
    id,
    repositoryId,
    state: "running",
    spec: {
      repositoryId,
      objective: "Report the fixture result",
      acceptanceCriteria: ["Return the backend summary"],
      constraints: ["Do not modify files"],
      attachmentIds: [],
      codingProfileId: null,
    },
    revision: 1,
    activeRunId: runId,
    runIds: [runId],
    evidenceIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    terminalSummary: null,
    workspaceConflict: null,
    codingSession: backend
      ? {
          backend,
          id: `${backend}-existing-session`,
          file: null,
          boundRunId: runId,
          recoveryBoundary: null,
        }
      : null,
    pendingQuestion: null,
    specHistory: [{ revision: 1, objective: "Report the fixture result", revisedAt: new Date(0).toISOString() }],
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fakeExecutable(repository: string, events: readonly Record<string, unknown>[]): string {
  const path = join(repository, "fake-coding-agent");
  const output = events
    .map((event) => `printf '%s\\n' ${shellQuote(JSON.stringify(event))}`)
    .join("\n");
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\n${output}\n`);
  chmodSync(path, 0o755);
  return path;
}

function evidence(input: ToolEvidenceInput, ordinal: number): EvidenceArtifact {
  return {
    id: `evidence-${ordinal}`,
    ordinal,
    taskId: input.taskId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    kind: input.changedFiles?.length ? "file_change" : "tool_result",
    summary: `${input.toolName} completed`,
    successful: !input.isError,
    payload: {},
    createdAt: new Date(0).toISOString(),
  };
}

async function exerciseBackend(
  backend: ExternalCodingBackend,
  events: readonly Record<string, unknown>[],
  resumed = false,
): Promise<{ summary: string; sessionIds: string[]; emittedTypes: string[]; evidenceIds: string[] }> {
  const repository = mkdtempSync(join(tmpdir(), `mamachi-${backend}-runner-`));
  temporaryDirectories.push(repository);
  const task = createTask(repository, resumed ? backend : undefined);
  const executable = fakeExecutable(repository, events);
  const completion = Promise.withResolvers<{ summary: string; evidenceIds: string[] }>();
  const sessionIds: string[] = [];
  const emittedTypes: string[] = [];
  let ordinal = 0;
  const runner = new ExternalCliRunner({
    backend,
    executable,
    getTask: (taskId) => taskId === task.id ? task : undefined,
    emit: (type) => emittedTypes.push(type),
    onSafePause: async () => accepted(),
    onAuthorizeTool: async () => accepted(),
    onWorkspaceConflict: async () => accepted(),
    onRecordEvidence: async (input) => evidence(input, ++ordinal),
    onComplete: async (_taskId, summary, evidenceIds) => {
      completion.resolve({ summary, evidenceIds });
      return accepted();
    },
    onFail: async (_taskId, error) => {
      completion.reject(new Error(error));
      return accepted();
    },
    onNeedInput: async () => accepted(),
    onSessionBound: async (_taskId, _runId, _backend, sessionId) => {
      sessionIds.push(sessionId);
      return accepted();
    },
    runtimeSettings: {
      ...defaultRuntimeSettings,
      codingBackend: backend,
      primaryModel: backend === "codex" ? "openai-codex/gpt-5.4-mini" : "anthropic/claude-sonnet-4-5",
      automaticRouting: false,
    },
  });
  runner.handleEvents([
    {
      type: resumed ? "task.resumed" : "task.started",
      taskId: task.id,
      payload: { runId: task.activeRunId!, revision: task.revision },
    } as DomainEvent,
  ]);
  const result = await completion.promise;
  await runner.dispose();
  return { ...result, sessionIds, emittedTypes };
}

describe("ExternalCliRunner", () => {
  test("maps provider-qualified models only to matching direct backends", () => {
    expect(modelForExternalBackend("codex", "openai-codex/gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(modelForExternalBackend("claude", "anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(modelForExternalBackend("codex", "anthropic/claude-sonnet-4-5")).toBeUndefined();
    expect(modelForExternalBackend("claude", "openai-codex/gpt-5.4-mini")).toBeUndefined();
  });

  test("streams Codex events, binds the subscription session, and records evidence", async () => {
    const result = await exerciseBackend("codex", [
      { type: "thread.started", thread_id: "codex-session" },
      {
        type: "item.started",
        item: { id: "command-1", type: "command_execution", command: "pwd", status: "in_progress" },
      },
      {
        type: "item.completed",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "pwd",
          aggregated_output: "/tmp/project",
          exit_code: 0,
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "Codex fixture complete" } },
      { type: "turn.completed" },
    ]);

    expect(result.summary).toBe("Codex fixture complete");
    expect(result.sessionIds).toEqual(["codex-session"]);
    expect(result.evidenceIds).toEqual(["evidence-1"]);
    expect(result.emittedTypes).toContain("coder.tool_started");
    expect(result.emittedTypes).toContain("coder.tool_finished");
  });

  test("streams Claude events and reuses a persisted subscription session", async () => {
    const result = await exerciseBackend("claude", [
      { type: "system", subtype: "init", session_id: "claude-existing-session", model: "claude-sonnet-4-5" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Claude fixture complete" }] },
      },
      { type: "result", subtype: "success", session_id: "claude-existing-session", result: "Claude fixture complete" },
    ], true);

    expect(result.summary).toBe("Claude fixture complete");
    expect(result.sessionIds).toEqual(["claude-existing-session"]);
    expect(result.evidenceIds).toEqual(["evidence-1"]);
    expect(result.emittedTypes).toContain("coder.ready");
    expect(result.emittedTypes).toContain("coder.running");
  });
});
