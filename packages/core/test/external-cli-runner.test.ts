import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fakeExecutable(
  repository: string,
  events: readonly Record<string, unknown>[],
  capture?: { argumentsPath?: string; promptPath?: string; environmentPath?: string },
): string {
  const path = join(repository, "fake-coding-agent");
  const output = events
    .flatMap((event) => {
      const item = typeof event["item"] === "object" && event["item"] !== null
        ? event["item"] as Record<string, unknown>
        : null;
      const hookInput = event["type"] === "item.started" && item
        ? {
            hook_event_name: "PreToolUse",
            tool_name: item["type"] === "command_execution" ? "Bash" : item["type"],
            tool_input: item["type"] === "command_execution" ? { command: item["command"] } : item,
            tool_use_id: item["id"],
          }
        : null;
      return [
        ...(hookInput
          ? [
              `printf '%s' ${shellQuote(JSON.stringify(hookInput))} | /usr/bin/curl --fail --silent --show-error --request POST --header "Authorization: Bearer $MAMACHI_POLICY_TOKEN" --header "Content-Type: application/json" --data-binary @- "$MAMACHI_POLICY_URL" >/dev/null`,
            ]
          : []),
        `printf '%s\\n' ${shellQuote(JSON.stringify(event))}`,
      ];
    })
    .join("\n");
  const setup = [
    ...(capture?.argumentsPath
      ? [`printf '%s\\n' "$@" > ${shellQuote(capture.argumentsPath)}`]
      : []),
    ...(capture?.environmentPath
      ? [`env | sort > ${shellQuote(capture.environmentPath)}`]
      : []),
    capture?.promptPath
      ? `cat > ${shellQuote(capture.promptPath)}`
      : "cat >/dev/null",
  ].join("\n");
  writeFileSync(path, `#!/bin/sh\n${setup}\n${output}\n`);
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
): Promise<{
  summary: string;
  sessionIds: string[];
  emittedTypes: string[];
  evidenceIds: string[];
  childEnvironment: string;
}> {
  const repository = mkdtempSync(join(tmpdir(), `mamachi-${backend}-runner-`));
  temporaryDirectories.push(repository);
  const task = createTask(repository, resumed ? backend : undefined);
  const environmentPath = join(repository, "captured-environment");
  const executable = fakeExecutable(repository, events, { environmentPath });
  const completion = Promise.withResolvers<{ summary: string; evidenceIds: string[] }>();
  const sessionIds: string[] = [];
  const emittedTypes: string[] = [];
  let ordinal = 0;
  const runner = new ExternalCliRunner({
    backend,
    executable,
    getTask: (taskId) => taskId === task.id ? task : undefined,
    environment: {
      OPENAI_API_KEY: "test-openai-secret",
      ANTHROPIC_API_KEY: "test-anthropic-secret",
      MAMACHI_ENCRYPTION_KEY: "test-encryption-secret",
      MAMACHI_TOKEN: "test-ipc-secret",
    },
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
  return {
    ...result,
    sessionIds,
    emittedTypes,
    childEnvironment: readFileSync(environmentPath, "utf8"),
  };
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
    expect(result.childEnvironment).not.toContain("test-openai-secret");
    expect(result.childEnvironment).not.toContain("test-anthropic-secret");
    expect(result.childEnvironment).not.toContain("test-encryption-secret");
    expect(result.childEnvironment).not.toContain("test-ipc-secret");
    expect(result.childEnvironment).toContain("MAMACHI_POLICY_URL=http://127.0.0.1:");
    expect(result.childEnvironment).toContain("MAMACHI_POLICY_TOKEN=");
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

  test("grants repository-local Git metadata access to explicit commit tasks", async () => {
    const repository = mkdtempSync(join(tmpdir(), "mamachi-codex-commit-"));
    temporaryDirectories.push(repository);
    const task = createTask(repository, "codex");
    // Deliberately never say "commit" in the objective — Git write access must come from
    // the accepted delivery mode, not from prose phrasing (the old regex heuristic is gone).
    task.spec.objective = "Persist the current working-tree changes to the repository history";
    task.spec.acceptanceCriteria = ["The current changes are saved with an agent-selected message"];
    task.spec.constraints = ["Do not modify files beyond what is needed to save existing changes"];
    task.spec.delivery = "commit";
    const argumentsPath = join(repository, "captured-arguments");
    const promptPath = join(repository, "captured-prompt");
    const environmentPath = join(repository, "captured-environment");
    const executable = fakeExecutable(repository, [
      { type: "thread.started", thread_id: "new-commit-session" },
      {
        type: "item.completed",
        item: { id: "message-commit", type: "agent_message", text: "Commit completed" },
      },
      { type: "turn.completed" },
    ], { argumentsPath, promptPath, environmentPath });
    const completed = Promise.withResolvers<void>();
    let ordinal = 0;
    const runner = new ExternalCliRunner({
      backend: "codex",
      executable,
      environment: {
        OPENAI_API_KEY: "test-openai-secret",
        ANTHROPIC_API_KEY: "test-anthropic-secret",
      },
      getTask: (taskId) => taskId === task.id ? task : undefined,
      emit: () => {},
      onSafePause: async () => accepted(),
      onAuthorizeTool: async () => accepted(),
      onWorkspaceConflict: async () => accepted(),
      onRecordEvidence: async (input) => evidence(input, ++ordinal),
      onComplete: async () => {
        completed.resolve();
        return accepted();
      },
      onFail: async (_taskId, error) => {
        completed.reject(new Error(error));
        return accepted();
      },
      onNeedInput: async () => {
        throw new Error("An explicitly authorized commit must not ask for the same permission again");
      },
      onSessionBound: async () => accepted(),
      runtimeSettings: {
        ...defaultRuntimeSettings,
        codingBackend: "codex",
        primaryModel: "openai-codex/gpt-5.4-mini",
        automaticRouting: false,
      },
    });

    runner.handleEvents([
      {
        type: "task.questionAnswered",
        taskId: task.id,
        payload: {
          questionId: Bun.randomUUIDv7(),
          runId: task.activeRunId!,
          revision: task.revision,
          answer: "Yes, grant write access to .git and commit the changes.",
        },
      } as DomainEvent,
      {
        type: "task.resumed",
        taskId: task.id,
        payload: { runId: task.activeRunId!, revision: task.revision },
      } as DomainEvent,
    ]);
    try {
      await completed.promise;
      const argumentsList = readFileSync(argumentsPath, "utf8").trim().split("\n");
      expect(argumentsList).toContain('sandbox_mode="workspace-write"');
      expect(argumentsList).toContain('approval_policy="never"');
      expect(argumentsList.some((argument) => argument.startsWith("hooks.PreToolUse="))).toBeTrue();
      expect(argumentsList).toContain("--add-dir");
      expect(argumentsList[argumentsList.indexOf("--add-dir") + 1]).toBe(join(repository, ".git"));
      expect(argumentsList).not.toContain("resume");
      expect(argumentsList).not.toContain("codex-existing-session");
      const prompt = readFileSync(promptPath, "utf8");
      expect(prompt).toContain("Delivery mode: commit");
      expect(prompt).toContain("authorizes staging and committing");
      expect(prompt).toContain("The exact answer to your pending question is: Yes, grant write access to .git");
      expect(prompt).not.toContain("Do not commit");
      const childEnvironment = readFileSync(environmentPath, "utf8");
      expect(childEnvironment).not.toContain("test-openai-secret");
      expect(childEnvironment).not.toContain("test-anthropic-secret");
    } finally {
      await runner.dispose();
    }
  });

  test("grants Git write and network only for pull_request delivery, and instructs opening a PR", async () => {
    const repository = mkdtempSync(join(tmpdir(), "mamachi-codex-pr-"));
    temporaryDirectories.push(repository);
    const task = createTask(repository);
    task.spec.objective = "Land the requested change and share it for review";
    task.spec.acceptanceCriteria = ["The change is implemented and offered for review"];
    task.spec.constraints = [];
    task.spec.delivery = "pull_request";
    const argumentsPath = join(repository, "captured-arguments");
    const promptPath = join(repository, "captured-prompt");
    const executable = fakeExecutable(repository, [
      { type: "thread.started", thread_id: "new-pr-session" },
      {
        type: "item.completed",
        item: { id: "message-pr", type: "agent_message", text: "Opened https://github.com/x/y/pull/1" },
      },
      { type: "turn.completed" },
    ], { argumentsPath, promptPath });
    const completed = Promise.withResolvers<void>();
    let ordinal = 0;
    const runner = new ExternalCliRunner({
      backend: "codex",
      executable,
      getTask: (taskId) => (taskId === task.id ? task : undefined),
      emit: () => {},
      onSafePause: async () => accepted(),
      onAuthorizeTool: async () => accepted(),
      onWorkspaceConflict: async () => accepted(),
      onRecordEvidence: async (input) => evidence(input, ++ordinal),
      onComplete: async () => {
        completed.resolve();
        return accepted();
      },
      onFail: async (_taskId, error) => {
        completed.reject(new Error(error));
        return accepted();
      },
      onNeedInput: async () => accepted(),
      onSessionBound: async () => accepted(),
      runtimeSettings: {
        ...defaultRuntimeSettings,
        codingBackend: "codex",
        primaryModel: "openai-codex/gpt-5.4-mini",
        automaticRouting: false,
      },
    });

    runner.handleEvents([
      {
        type: "task.started",
        taskId: task.id,
        payload: { runId: task.activeRunId!, revision: task.revision },
      } as DomainEvent,
    ]);
    try {
      await completed.promise;
      const argumentsList = readFileSync(argumentsPath, "utf8").trim().split("\n");
      expect(argumentsList).toContain("sandbox_workspace_write.network_access=true");
      expect(argumentsList).toContain("--add-dir");
      expect(argumentsList[argumentsList.indexOf("--add-dir") + 1]).toBe(join(repository, ".git"));
      const prompt = readFileSync(promptPath, "utf8");
      expect(prompt).toContain("Delivery mode: pull_request");
      expect(prompt).toContain("gh pr create");
    } finally {
      await runner.dispose();
    }
  });

  test("keeps a default working_tree task off the network and out of .git", async () => {
    const repository = mkdtempSync(join(tmpdir(), "mamachi-codex-wt-"));
    temporaryDirectories.push(repository);
    const task = createTask(repository);
    const argumentsPath = join(repository, "captured-arguments");
    const executable = fakeExecutable(repository, [
      { type: "thread.started", thread_id: "new-wt-session" },
      {
        type: "item.completed",
        item: { id: "message-wt", type: "agent_message", text: "Done" },
      },
      { type: "turn.completed" },
    ], { argumentsPath });
    const completed = Promise.withResolvers<void>();
    let ordinal = 0;
    const runner = new ExternalCliRunner({
      backend: "codex",
      executable,
      getTask: (taskId) => (taskId === task.id ? task : undefined),
      emit: () => {},
      onSafePause: async () => accepted(),
      onAuthorizeTool: async () => accepted(),
      onWorkspaceConflict: async () => accepted(),
      onRecordEvidence: async (input) => evidence(input, ++ordinal),
      onComplete: async () => {
        completed.resolve();
        return accepted();
      },
      onFail: async (_taskId, error) => {
        completed.reject(new Error(error));
        return accepted();
      },
      onNeedInput: async () => accepted(),
      onSessionBound: async () => accepted(),
      runtimeSettings: {
        ...defaultRuntimeSettings,
        codingBackend: "codex",
        primaryModel: "openai-codex/gpt-5.4-mini",
        automaticRouting: false,
      },
    });

    runner.handleEvents([
      {
        type: "task.started",
        taskId: task.id,
        payload: { runId: task.activeRunId!, revision: task.revision },
      } as DomainEvent,
    ]);
    try {
      await completed.promise;
      const argumentsList = readFileSync(argumentsPath, "utf8").trim().split("\n");
      expect(argumentsList).not.toContain("sandbox_workspace_write.network_access=true");
      expect(argumentsList).not.toContain("--add-dir");
    } finally {
      await runner.dispose();
    }
  });

  test("blocks a denied external tool before its side effect", async () => {
    const repository = mkdtempSync(join(tmpdir(), "mamachi-codex-policy-"));
    temporaryDirectories.push(repository);
    const task = createTask(repository);
    const executable = join(repository, "fake-coding-agent");
    const sideEffectPath = join(repository, "forbidden-side-effect");
    const hookInput = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `touch ${sideEffectPath}` },
      tool_use_id: "denied-command",
    });
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        `response="$(printf '%s' ${shellQuote(hookInput)} | /usr/bin/curl --fail --silent --show-error --request POST --header "Authorization: Bearer $MAMACHI_POLICY_TOKEN" --header "Content-Type: application/json" --data-binary @- "$MAMACHI_POLICY_URL")"`,
        `case "$response" in *'"permissionDecision":"deny"'*) ;; *) touch ${shellQuote(sideEffectPath)} ;; esac`,
        "sleep 1",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    const paused = Promise.withResolvers<void>();
    const runner = new ExternalCliRunner({
      backend: "codex",
      executable,
      getTask: (taskId) => taskId === task.id ? task : undefined,
      emit: () => {},
      onSafePause: async () => {
        paused.resolve();
        return accepted();
      },
      onAuthorizeTool: async () => ({
        status: "rejected",
        code: "credential_access",
        explanation: "fixture policy denial",
      }),
      onWorkspaceConflict: async () => accepted(),
      onRecordEvidence: async (input) => evidence(input, 1),
      onComplete: async () => {
        throw new Error("A denied tool must pause rather than complete");
      },
      onFail: async (_taskId, error) => {
        paused.reject(new Error(error));
        return accepted();
      },
      onNeedInput: async () => accepted(),
      runtimeSettings: {
        ...defaultRuntimeSettings,
        codingBackend: "codex",
        automaticRouting: false,
      },
    });
    runner.handleEvents([{
      type: "task.started",
      taskId: task.id,
      payload: { runId: task.activeRunId!, revision: task.revision },
    } as DomainEvent]);
    try {
      await paused.promise;
      expect(Bun.file(sideEffectPath).size).toBe(0);
    } finally {
      await runner.dispose();
    }
  });
});
