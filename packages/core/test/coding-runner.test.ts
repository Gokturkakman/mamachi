import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import { CodingRunner } from "../src/coding-runner.ts";
import type { TaskRecord } from "../src/domain.ts";
import { defaultRuntimeSettings } from "../src/model-router.ts";

function accepted(): ActionResult {
  return { status: "accepted", eventId: Bun.randomUUIDv7() };
}

function createTask(repositoryId: string): TaskRecord {
  const id = Bun.randomUUIDv7();
  return {
    id,
    repositoryId,
    state: "running",
    spec: {
      repositoryId,
      objective: "Implement the requested behavior",
      acceptanceCriteria: ["The behavior is verified"],
      constraints: [],
      attachmentIds: [],
      codingProfileId: null,
    },
    revision: 1,
    activeRunId: Bun.randomUUIDv7(),
    runIds: [],
    evidenceIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    terminalSummary: null,
    workspaceConflict: null,
    codingSession: null,
    pendingQuestion: null,
    specHistory: [{ revision: 1, objective: "Implement the requested behavior", revisedAt: new Date(0).toISOString() }],
  };
}

function createFakeSession(id: string, onFollowUp: (text: string) => void): AgentSession {
  const session = {
    sessionId: id,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionManager: { ensureOnDisk: async () => undefined },
    agent: { waitForIdle: async () => undefined },
    model: undefined,
    isStreaming: false,
    subscribe: () => () => undefined,
    prompt: async () => {
      await new Promise(() => undefined);
      return true;
    },
    followUp: async (text: string) => onFollowUp(text),
    steer: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
    getLastAssistantMessage: () => ({ stopReason: "stop" }),
    getLastAssistantText: () => "fallback summary",
  };
  return session as unknown as AgentSession;
}

function startedEvent(task: TaskRecord): DomainEvent {
  return {
    type: "task.started",
    taskId: task.id,
    payload: { runId: task.activeRunId!, revision: 1 },
  } as DomainEvent;
}

describe("CodingRunner lanes", () => {
  test("gives each repository its own OMP session and routes askCoder/steer/followUp by task", async () => {
    const repoA = mkdtempSync(join(tmpdir(), "mamachi-lane-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "mamachi-lane-b-"));
    try {
      const taskA = createTask(repoA);
      const taskB = createTask(repoB);
      const tasks = new Map([[taskA.id, taskA], [taskB.id, taskB]]);
      const sessionsCreatedFor: string[] = [];
      const followUpsA: string[] = [];
      const followUpsB: string[] = [];
      const ready = { a: Promise.withResolvers<void>(), b: Promise.withResolvers<void>() };

      const runner = new CodingRunner({
        getTask: (taskId) => tasks.get(taskId),
        emit: (type, payload) => {
          if (type !== "coder.ready") return;
          const taskId = (payload as { taskId: string }).taskId;
          if (taskId === taskA.id) ready.a.resolve();
          if (taskId === taskB.id) ready.b.resolve();
        },
        onSafePause: async () => accepted(),
        onAuthorizeTool: async () => accepted(),
        onWorkspaceConflict: async () => accepted(),
        onRecordEvidence: async () => {
          throw new Error("No tool evidence expected in this test");
        },
        onComplete: async () => accepted(),
        onFail: async (_taskId, error) => {
          throw new Error(error);
        },
        onNeedInput: async () => accepted(),
        onSessionBound: async () => accepted(),
        runtimeSettings: defaultRuntimeSettings,
        createSession: async (options) => {
          sessionsCreatedFor.push(options.cwd as string);
          const session =
            options.cwd === repoA
              ? createFakeSession("session-a", (text) => followUpsA.push(text))
              : createFakeSession("session-b", (text) => followUpsB.push(text));
          return { session } as CreateAgentSessionResult;
        },
      });

      runner.handleEvents([startedEvent(taskA)]);
      runner.handleEvents([startedEvent(taskB)]);
      await Promise.all([ready.a.promise, ready.b.promise]);

      expect(sessionsCreatedFor.sort()).toEqual([repoA, repoB].sort());

      expect(await runner.followUp(taskB.id, "Only repo B should see this")).toBe(true);
      expect(followUpsB.some((text) => text.includes("Only repo B should see this"))).toBe(true);
      expect(followUpsA).toHaveLength(0);

      expect(await runner.followUp(taskA.id, "Only repo A should see this")).toBe(true);
      expect(followUpsA.some((text) => text.includes("Only repo A should see this"))).toBe(true);
      expect(followUpsB).toHaveLength(1);

      await runner.dispose();
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});
