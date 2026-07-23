import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import { TaskController } from "../src/controller.ts";
import type { TaskRecord } from "../src/domain.ts";
import { EventStore } from "../src/event-store.ts";
import { OmpRunner, type OmpRunnerOptions } from "../src/omp-runner.ts";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
};

function accepted(): ActionResult {
  return { status: "accepted", eventId: Bun.randomUUIDv7() };
}

function createTask(repositoryId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
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
    ...overrides,
  };
}

function createFakeSession(options: {
  id?: string;
  file?: string;
  onPrompt?: () => Promise<void>;
  onFollowUp?: (text: string) => Promise<void>;
  onSteer?: (text: string) => Promise<void>;
  isStreaming?: () => boolean;
}): AgentSession {
  const session = {
    sessionId: options.id ?? "omp-test-session",
    sessionFile: options.file ?? "/tmp/omp-test-session.jsonl",
    sessionManager: { ensureOnDisk: async () => undefined },
    agent: { waitForIdle: async () => undefined },
    model: undefined,
    get isStreaming() {
      return options.isStreaming?.() ?? false;
    },
    subscribe: () => () => undefined,
    prompt: async () => {
      await options.onPrompt?.();
      return true;
    },
    followUp: async (text: string) => options.onFollowUp?.(text),
    steer: async (text: string) => options.onSteer?.(text),
    abort: async () => undefined,
    dispose: async () => undefined,
    getLastAssistantMessage: () => ({ stopReason: "stop" }),
    getLastAssistantText: () => "fallback summary",
  };
  return session as unknown as AgentSession;
}

function installExtensions(options: CreateAgentSessionOptions): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const extensionApi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    on: () => undefined,
  };
  for (const extension of options.extensions ?? []) {
    extension(extensionApi as never);
  }
  return tools;
}

function runnerOptions(
  task: TaskRecord,
  createSession: NonNullable<OmpRunnerOptions["createSession"]>,
): OmpRunnerOptions {
  return {
    getTask: (taskId) => (taskId === task.id ? task : undefined),
    emit: () => undefined,
    onSafePause: async () => accepted(),
    onAuthorizeTool: async () => accepted(),
    onWorkspaceConflict: async () => accepted(),
    onRecordEvidence: async () => {
      throw new Error("No tool evidence expected in this runner test");
    },
    onComplete: async () => accepted(),
    onFail: async (_taskId, error) => {
      throw new Error(error);
    },
    onNeedInput: async () => accepted(),
    onSessionBound: async () => accepted(),
    createSession,
  };
}

describe("OmpRunner steering and recovery", () => {
  test("persists ask_coder state and resumes the same OMP session with the exact answer", async () => {
    const repository = mkdtempSync(join(tmpdir(), "mamachi-runner-question-"));
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const submitted = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: {
          repositoryId: repository,
          objective: "Implement the requested behavior",
          acceptanceCriteria: ["The behavior is verified"],
          constraints: [],
          attachmentIds: [],
          codingProfileId: null,
        },
      });
      if (submitted.status !== "accepted" || !submitted.taskId) throw new Error("Submission failed");
      const taskId = submitted.taskId;
      let tools: RegisteredTool[] = [];
      const followUps: string[] = [];
      let createCount = 0;
      const questionReady = Promise.withResolvers<void>();
      const completionReady = Promise.withResolvers<void>();
      const session = createFakeSession({
        onPrompt: async () => {
          const ask = tools.find((tool) => tool.name === "ask_coder");
          if (!ask) throw new Error("ask_coder was not registered");
          await ask.execute("ask-1", { question: "Which deployment target should I use?" });
        },
        onFollowUp: async (text) => {
          followUps.push(text);
          const finish = tools.find((tool) => tool.name === "finish_coder");
          if (!finish) throw new Error("finish_coder was not registered");
          await finish.execute("finish-1", { summary: "Implemented and verified for staging." });
        },
      });
      let completion = "";
      const runner = new OmpRunner({
        ...runnerOptions(controller.snapshot().tasks[0]!, async (options) => {
          createCount += 1;
          tools = installExtensions(options);
          return { session } as CreateAgentSessionResult;
        }),
        getTask: (candidate) => controller.snapshot().tasks.find((task) => task.id === candidate),
        onNeedInput: async (candidate, question) => {
          const result = controller.awaitUserInput(Bun.randomUUIDv7(), candidate, question);
          questionReady.resolve();
          return result;
        },
        onSessionBound: async (candidate, runId, backend, sessionId, sessionFile) =>
          controller.recordCoderSession(Bun.randomUUIDv7(), candidate, runId, backend, sessionId, sessionFile),
        onComplete: async (_candidate, summary) => {
          completion = summary;
          completionReady.resolve();
          return accepted();
        },
      });

      runner.handleEvents(controller.eventsAfter());
      await questionReady.promise;
      let snapshot = controller.snapshot();
      const question = snapshot.questions?.[0];
      expect(question).toMatchObject({
        taskId,
        taskRevision: 1,
        state: "open",
        question: "Which deployment target should I use?",
      });
      expect(createCount).toBe(1);

      const beforeAnswer = snapshot.seq;
      const answer = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId, questionId: question!.id, answer: "Use staging." },
      });
      expect(answer.status).toBe("accepted");
      runner.handleEvents(controller.eventsAfter(beforeAnswer));
      await completionReady.promise;

      expect(createCount).toBe(1);
      expect(followUps).toHaveLength(1);
      expect(followUps[0]).toContain("Use staging.");
      expect(completion).toBe("Implemented and verified for staging.");
      snapshot = controller.snapshot();
      expect(snapshot.questions?.[0]).toMatchObject({ state: "resolved", answer: "Use staging." });
      await runner.dispose();
    } finally {
      store.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("routes urgent clarification to steer and non-urgent work to followUp", async () => {
    const repository = mkdtempSync(join(tmpdir(), "mamachi-runner-steer-"));
    try {
      const task = createTask(repository);
      let streaming = true;
      const promptGate = Promise.withResolvers<void>();
      const sessionReady = Promise.withResolvers<void>();
      const promptFinished = Promise.withResolvers<void>();
      const steers: string[] = [];
      const followUps: string[] = [];
      const asks: string[] = [];
      const session = createFakeSession({
        isStreaming: () => streaming,
        onPrompt: async () => {
          await promptGate.promise;
          promptFinished.resolve();
        },
        onSteer: async (text) => {
          steers.push(text);
        },
        onFollowUp: async (text) => {
          if (text.startsWith("Answer this read-only")) asks.push(text);
          else followUps.push(text);
        },
      });
      const runner = new OmpRunner({
        ...runnerOptions(task, async () => ({ session }) as CreateAgentSessionResult),
        emit: (type) => {
          if (type === "coder.ready") sessionReady.resolve();
        },
      });
      runner.handleEvents([
        {
          type: "task.started",
          taskId: task.id,
          payload: { runId: task.activeRunId!, revision: 1 },
        } as DomainEvent,
      ]);
      await sessionReady.promise;

      expect(await runner.steer(task.id, "The safe target is staging.")).toBe(true);
      expect(await runner.followUp(task.id, "Also update the existing comment.")).toBe(true);
      expect(await runner.askCoder(task.id, "Which tests cover this file?")).toBe(true);
      expect(steers[0]).toContain("The safe target is staging.");
      expect(followUps[0]).toContain("Also update the existing comment.");
      expect(asks[0]).toContain("Which tests cover this file?");

      task.state = "awaiting_user";
      streaming = false;
      promptGate.resolve();
      await promptFinished.promise;
      await runner.dispose();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("reopens only the task-bound session and reports a no-replay recovery boundary", async () => {
    const repository = mkdtempSync(join(tmpdir(), "mamachi-runner-recovery-"));
    try {
      const previousRunId = Bun.randomUUIDv7();
      const task = createTask(repository, {
        codingSession: {
          backend: "omp",
          id: "omp-recovery-session",
          file: "/tmp/bound-session.jsonl",
          boundRunId: previousRunId,
          recoveryBoundary: {
            runId: previousRunId,
            reason: "Unknown in-flight tool at daemon restart",
            unknownToolCall: true,
            recordedAt: new Date(0).toISOString(),
          },
        },
      });
      const manager = { marker: "bound-manager" } as unknown as SessionManager;
      const prompts: string[] = [];
      const emitted: Array<{ type: string; payload: unknown }> = [];
      let opened = "";
      let receivedManager: SessionManager | undefined;
      const recoveryFinished = Promise.withResolvers<void>();
      const session = createFakeSession({
        id: "omp-recovery-session",
        file: "/tmp/bound-session.jsonl",
        onPrompt: async () => undefined,
      });
      const runner = new OmpRunner({
        ...runnerOptions(task, async (options) => {
          receivedManager = options.sessionManager;
          const originalPrompt = session.prompt.bind(session);
          session.prompt = async (prompt, promptOptions) => {
            prompts.push(prompt);
            return originalPrompt(prompt, promptOptions);
          };
          return { session } as CreateAgentSessionResult;
        }),
        emit: (type, payload) => emitted.push({ type, payload }),
        openSession: async (sessionFile) => {
          opened = sessionFile;
          return manager;
        },
        onComplete: async () => {
          recoveryFinished.resolve();
          return accepted();
        },
      });

      runner.handleEvents([
        {
          type: "task.resumed",
          taskId: task.id,
          payload: { runId: task.activeRunId!, revision: 1 },
        } as DomainEvent,
      ]);
      await recoveryFinished.promise;

      expect(opened).toBe("/tmp/bound-session.jsonl");
      expect(receivedManager).toBe(manager);
      expect(prompts[0]).toContain("Never replay that unknown tool call");
      expect(emitted).toContainEqual({
        type: "coder.recovery_boundary",
        payload: expect.objectContaining({
          taskId: task.id,
          unknownToolCall: true,
          replayedToolCall: false,
        }),
      });
      await runner.dispose();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
