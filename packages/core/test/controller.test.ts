import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskController } from "../src/controller.ts";
import { EventStore } from "../src/event-store.ts";

const spec = {
  repositoryId: "repo_alpha",
  objective: "Change an observable behavior",
  acceptanceCriteria: ["The changed behavior is verified"],
  constraints: ["Preserve existing user work"],
  attachmentIds: [],
  codingProfileId: "gpt-5.6-sol",
};

function submit(
  controller: TaskController,
  id = Bun.randomUUIDv7(),
  codingProfileId = spec.codingProfileId,
): string {
  const result = controller.handle({
    id,
    type: "task.submit",
    actor: "voice",
    expectedRevision: null,
    payload: { ...spec, codingProfileId },
  });
  if (result.status !== "accepted" || !result.taskId) throw new Error("Task submission failed");
  return result.taskId;
}

function submitToRepository(controller: TaskController, repositoryId: string): string {
  const result = controller.handle({
    id: Bun.randomUUIDv7(),
    type: "task.submit",
    actor: "voice",
    expectedRevision: null,
    payload: { ...spec, repositoryId },
  });
  if (result.status !== "accepted" || !result.taskId) throw new Error("Task submission failed");
  return result.taskId;
}

describe("TaskController", () => {
  test("runs one task and atomically starts the next queued task", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store, {
        validateEvidence: () => ({
          valid: true,
          implementationComplete: true,
          verificationComplete: true,
          explanation: "test evidence accepted",
        }),
      });
      const firstTaskId = submit(controller);
      const secondTaskId = submit(controller);

      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(firstTaskId);
      expect(snapshot.queue).toEqual([secondTaskId]);

      const completion = controller.completeTask(
        Bun.randomUUIDv7(),
        firstTaskId,
        "The requested behavior was verified",
        [Bun.randomUUIDv7()],
      );
      expect(completion.status).toBe("accepted");

      snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(secondTaskId);
      expect(snapshot.queue).toEqual([]);
      expect(snapshot.tasks.find((task) => task.id === firstTaskId)?.state).toBe("completed");
      expect(snapshot.tasks.find((task) => task.id === secondTaskId)?.state).toBe("running");
      expect(controller.eventsAfter().map((event) => event.type).slice(-2)).toEqual([
        "task.completed",
        "task.started",
      ]);
    } finally {
      store.close();
    }
  });

  test("prioritizes substantive coding work ahead of queued fast research", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const activeTaskId = submit(controller);
      const firstResearchId = submit(controller, Bun.randomUUIDv7(), "fast");
      const secondResearchId = submit(controller, Bun.randomUUIDv7(), "fast");
      const codingTaskId = submit(controller);

      expect(controller.snapshot().activeTaskId).toBe(activeTaskId);
      expect(controller.snapshot().queue).toEqual([
        codingTaskId,
        firstResearchId,
        secondResearchId,
      ]);
    } finally {
      store.close();
    }
  });

  test("deduplicates a repeated command without appending events", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const commandId = Bun.randomUUIDv7();
      const command = {
        id: commandId,
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: spec,
      };

      const first = controller.handle(command);
      const eventCount = store.eventCount();
      const repeated = controller.handle(command);

      expect(repeated).toEqual(first);
      expect(store.eventCount()).toBe(eventCount);
      expect(controller.snapshot().tasks).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("pauses at a safe boundary, revises immutably, and resumes in a new run", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);

      const requested = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId, reason: "The architecture changed" },
      });
      expect(requested.status).toBe("accepted");
      expect(controller.snapshot().tasks[0]?.state).toBe("pause_requested");

      const paused = controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskId);
      expect(paused.status).toBe("accepted");
      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(taskId);
      expect(snapshot.tasks[0]?.state).toBe("paused");
      expect(snapshot.runs[0]?.state).toBe("paused");

      const revised = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.revise",
        actor: "voice",
        expectedRevision: 1,
        payload: {
          taskId,
          spec: {
            ...spec,
            acceptanceCriteria: [...spec.acceptanceCriteria, "The revised architecture is used"],
          },
        },
      });
      expect(revised.status).toBe("accepted");

      const staleResume = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(staleResume).toEqual({
        status: "conflict",
        currentRevision: 2,
        explanation: `Task ${taskId} is at revision 2, not 1`,
      });

      const resumed = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "voice",
        expectedRevision: 2,
        payload: { taskId },
      });
      expect(resumed.status).toBe("accepted");

      snapshot = controller.snapshot();
      expect(snapshot.tasks[0]?.revision).toBe(2);
      expect(snapshot.tasks[0]?.runIds).toHaveLength(2);
      expect(snapshot.runs.map((run) => run.state)).toEqual(["paused", "running"]);
    } finally {
      store.close();
    }
  });

  test("keeps the repository identity immutable across revisions", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId, reason: "Revise the task" },
      });
      controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskId);

      const result = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.revise",
        actor: "voice",
        expectedRevision: 1,
        payload: {
          taskId,
          spec: { ...spec, repositoryId: "repo_other" },
        },
      });

      expect(result.status).toBe("rejected");
      expect(controller.snapshot().tasks[0]?.repositoryId).toBe("repo_alpha");
      expect(controller.snapshot().tasks[0]?.revision).toBe(1);
    } finally {
      store.close();
    }
  });

  test("recovers an unfinished run as paused and never resumes it implicitly", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-controller-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const firstStore = new EventStore(databasePath);
      const firstController = new TaskController(firstStore);
      const taskId = submit(firstController);
      const runId = firstController.snapshot().tasks[0]?.activeRunId;
      if (!runId) throw new Error("Submitted task did not start");
      expect(
        firstController.recordCoderSession(
          Bun.randomUUIDv7(),
          taskId,
          runId,
          "omp",
          "omp-session-1",
          "/tmp/omp-session-1.jsonl",
        ).status,
      ).toBe("accepted");
      firstStore.close();

      const recoveryStore = new EventStore(databasePath);
      const recoveryController = new TaskController(recoveryStore);
      expect(recoveryController.snapshot().tasks[0]?.state).toBe("running");
      const recovery = recoveryController.recoverAfterRestart(Bun.randomUUIDv7());
      expect(recovery.status).toBe("accepted");
      let snapshot = recoveryController.snapshot();
      expect(snapshot.activeTaskId).toBe(taskId);
      expect(snapshot.tasks[0]?.state).toBe("paused");
      expect(snapshot.runs[0]?.state).toBe("interrupted");
      expect(snapshot.tasks[0]?.codingSession).toMatchObject({
        backend: "omp",
        id: "omp-session-1",
        file: "/tmp/omp-session-1.jsonl",
        recoveryBoundary: {
          runId,
          unknownToolCall: true,
        },
      });
      expect(recoveryController.eventsAfter().slice(-3).map((event) => event.type)).toEqual([
        "run.interrupted",
        "coder.recoveryBoundary",
        "task.paused",
      ]);
      recoveryStore.close();

      const replayStore = new EventStore(databasePath);
      const replayController = new TaskController(replayStore);
      snapshot = replayController.snapshot();
      expect(snapshot.tasks[0]?.state).toBe("paused");
      expect(snapshot.runs[0]?.state).toBe("interrupted");
      expect(snapshot.tasks[0]?.codingSession?.recoveryBoundary?.unknownToolCall).toBe(true);
      expect(replayController.recoverAfterRestart(Bun.randomUUIDv7()).status).toBe("rejected");
      replayStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reorders only queued tasks and preserves the active slot", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const activeTaskId = submit(controller);
      const secondTaskId = submit(controller);
      const thirdTaskId = submit(controller);

      const moved = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "queue.move",
        actor: "voice",
        expectedRevision: null,
        payload: {
          taskId: thirdTaskId,
          operation: "move_before",
          anchorTaskId: secondTaskId,
        },
      });

      expect(moved.status).toBe("accepted");
      expect(controller.snapshot().activeTaskId).toBe(activeTaskId);
      expect(controller.snapshot().queue).toEqual([thirdTaskId, secondTaskId]);
    } finally {
      store.close();
    }
  });

  test("binds a coder question to its task revision and run, then accepts one exact answer", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const questionId = Bun.randomUUIDv7();
      const originalRunId = controller.snapshot().tasks[0]?.activeRunId;
      const awaiting = controller.awaitUserInput(
        questionId,
        taskId,
        "Which deployment target should I use?",
      );
      expect(awaiting.status).toBe("accepted");
      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(taskId);
      expect(snapshot.tasks[0]).toMatchObject({
        state: "awaiting_user",
        pendingQuestion: "Which deployment target should I use?",
      });
      expect(snapshot.runs[0]?.state).toBe("paused");
      expect(snapshot.questions?.[0]).toMatchObject({
        id: questionId,
        taskId,
        taskRevision: 1,
        runId: originalRunId,
        state: "open",
      });
      expect(controller.eventsAfter().at(-1)?.type).toBe("task.questionAsked");

      const genericResume = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(genericResume).toMatchObject({ status: "rejected", code: "question_pending" });

      const answer = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId, questionId, answer: "Deploy to staging." },
      });
      expect(answer.status).toBe("accepted");
      snapshot = controller.snapshot();
      expect(snapshot.tasks[0]).toMatchObject({ state: "running", pendingQuestion: null });
      expect(snapshot.runs).toHaveLength(2);
      expect(snapshot.questions?.[0]).toMatchObject({
        id: questionId,
        state: "resolved",
        resolution: "answered",
        answer: "Deploy to staging.",
      });
      expect(controller.eventsAfter().slice(-2).map((event) => event.type)).toEqual([
        "task.questionAnswered",
        "task.resumed",
      ]);

      const duplicate = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId, questionId, answer: "Deploy to production instead." },
      });
      expect(duplicate).toMatchObject({ status: "rejected", code: "stale_question" });
    } finally {
      store.close();
    }
  });

  test("rejects an answer after a consequential task revision supersedes its question", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const questionId = Bun.randomUUIDv7();
      expect(
        controller.awaitUserInput(questionId, taskId, "Should this alter the public API?").status,
      ).toBe("accepted");
      expect(
        controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.revise",
          actor: "ui",
          expectedRevision: 1,
          payload: {
            taskId,
            spec: { ...spec, objective: "Change the behavior without altering the public API" },
          },
        }).status,
      ).toBe("accepted");

      const stale = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "ui",
        expectedRevision: 2,
        payload: { taskId, questionId, answer: "Yes." },
      });
      expect(stale).toMatchObject({ status: "rejected", code: "stale_question" });
      expect(controller.snapshot().questions?.[0]).toMatchObject({
        state: "resolved",
        resolution: "superseded",
        answer: null,
      });
    } finally {
      store.close();
    }
  });

  test("requires revision-bound single-use approval for risky tool effects", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const proposed = controller.authorizeToolCall(
        Bun.randomUUIDv7(),
        taskId,
        "bash",
        { command: "git push origin main" },
      );
      if (proposed.status !== "confirmation_required") throw new Error("Risky action was not held for approval");

      let snapshot = controller.snapshot();
      expect(snapshot.tasks[0]?.state).toBe("awaiting_user");
      expect(snapshot.confirmations[0]).toMatchObject({
        id: proposed.confirmationId,
        taskId,
        taskRevision: 1,
        state: "pending",
      });

      const bypass = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(bypass).toMatchObject({ status: "rejected", code: "confirmation_pending" });

      const approved = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "approval.resolve",
        actor: "ui",
        expectedRevision: 1,
        payload: { confirmationId: proposed.confirmationId, decision: "approve" },
      });
      expect(approved.status).toBe("accepted");

      const consumed = controller.authorizeToolCall(
        Bun.randomUUIDv7(),
        taskId,
        "bash",
        { command: "git push origin main" },
      );
      expect(consumed.status).toBe("accepted");
      snapshot = controller.snapshot();
      expect(snapshot.confirmations[0]?.state).toBe("consumed");

      const repeated = controller.authorizeToolCall(
        Bun.randomUUIDv7(),
        taskId,
        "bash",
        { command: "git push origin main" },
      );
      expect(repeated.status).toBe("confirmation_required");
      expect(controller.snapshot().confirmations).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("pauses on a workspace conflict and records explicit reconciliation before resuming", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const originalRunId = controller.snapshot().tasks[0]?.activeRunId;
      const conflict = controller.reportWorkspaceConflict(
        Bun.randomUUIDv7(),
        taskId,
        ["src/feature.ts"],
        "The user changed a target file",
      );
      expect(conflict.status).toBe("accepted");
      expect(controller.snapshot().tasks[0]).toMatchObject({
        state: "awaiting_user",
        activeRunId: null,
        workspaceConflict: {
          paths: ["src/feature.ts"],
          reason: "The user changed a target file",
        },
      });

      const resumed = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(resumed.status).toBe("accepted");
      const task = controller.snapshot().tasks[0];
      expect(task).toMatchObject({
        state: "running",
        workspaceConflict: null,
      });
      expect(task?.activeRunId).not.toBe(originalRunId);
      expect(controller.eventsAfter().map((event) => event.type).slice(-2)).toEqual([
        "workspace.conflictResolved",
        "task.resumed",
      ]);
    } finally {
      store.close();
    }
  });

  test("tracks the pending question and spec history through revision and replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-spec-history-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const store = new EventStore(databasePath);
      const controller = new TaskController(store);
      const taskId = submit(controller);
      let task = controller.snapshot().tasks[0];
      expect(task?.pendingQuestion).toBeNull();
      expect(task?.specHistory).toEqual([
        { revision: 1, objective: spec.objective, revisedAt: task?.createdAt ?? "" },
      ]);

      const question = "Should the new endpoint be versioned?";
      expect(controller.awaitUserInput(Bun.randomUUIDv7(), taskId, question).status).toBe("accepted");
      task = controller.snapshot().tasks[0];
      expect(task?.state).toBe("awaiting_user");
      expect(task?.pendingQuestion).toBe(question);

      const revisedObjective = "Change an observable behavior and record telemetry";
      const revised = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.revise",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId, spec: { ...spec, objective: revisedObjective } },
      });
      expect(revised.status).toBe("accepted");
      task = controller.snapshot().tasks[0];
      expect(task?.revision).toBe(2);
      expect(task?.pendingQuestion).toBeNull();
      expect(task?.specHistory.map((entry) => [entry.revision, entry.objective])).toEqual([
        [1, spec.objective],
        [2, revisedObjective],
      ]);

      const resumed = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 2,
        payload: { taskId },
      });
      expect(resumed.status).toBe("accepted");
      expect(controller.snapshot().tasks[0]?.pendingQuestion).toBeNull();

      const live = controller.snapshot();
      store.close();
      const replayStore = new EventStore(databasePath);
      const replayed = new TaskController(replayStore).snapshot();
      expect(replayed.tasks).toEqual(live.tasks);
      replayStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("runs one task per repository concurrently, each repository its own lane", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store, {
        validateEvidence: () => ({
          valid: true,
          implementationComplete: true,
          verificationComplete: true,
          explanation: "test evidence accepted",
        }),
      });
      const alphaFirst = submitToRepository(controller, "repo_alpha");
      const betaFirst = submitToRepository(controller, "repo_beta");
      const alphaSecond = submitToRepository(controller, "repo_alpha");

      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskIds).toEqual({ repo_alpha: alphaFirst, repo_beta: betaFirst });
      expect(snapshot.queue).toEqual([alphaSecond]);
      expect(snapshot.tasks.find((task) => task.id === betaFirst)?.state).toBe("running");

      const completion = controller.completeTask(
        Bun.randomUUIDv7(),
        alphaFirst,
        "Alpha work verified",
        [Bun.randomUUIDv7()],
      );
      expect(completion.status).toBe("accepted");

      snapshot = controller.snapshot();
      expect(snapshot.activeTaskIds).toEqual({ repo_alpha: alphaSecond, repo_beta: betaFirst });
      expect(snapshot.tasks.find((task) => task.id === betaFirst)?.state).toBe("running");
      expect(snapshot.tasks.find((task) => task.id === alphaSecond)?.state).toBe("running");
    } finally {
      store.close();
    }
  });

  test("cancelling a queued task never starts it as its own successor, and lanes stay independent", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const alphaFirst = submitToRepository(controller, "repo_alpha");
      const alphaSecond = submitToRepository(controller, "repo_alpha");
      const betaFirst = submitToRepository(controller, "repo_beta");

      expect(controller.snapshot().queue).toEqual([alphaSecond]);

      const cancelQueued = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.cancel",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId: alphaSecond, reason: "No longer needed" },
      });
      expect(cancelQueued.status).toBe("accepted");
      expect(controller.eventsAfter().at(-1)?.type).toBe("task.cancelled");

      let snapshot = controller.snapshot();
      expect(snapshot.tasks.find((task) => task.id === alphaSecond)?.state).toBe("cancelled");
      expect(snapshot.activeTaskIds).toEqual({ repo_alpha: alphaFirst, repo_beta: betaFirst });
      expect(snapshot.queue).toEqual([]);

      const cancelActive = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.cancel",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId: alphaFirst, reason: "Superseded" },
      });
      expect(cancelActive.status).toBe("accepted");

      snapshot = controller.snapshot();
      expect(snapshot.activeTaskIds).toEqual({ repo_beta: betaFirst });
      expect(snapshot.tasks.find((task) => task.id === betaFirst)?.state).toBe("running");
    } finally {
      store.close();
    }
  });

  test("recovers every lane's unfinished run independently after a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-controller-lanes-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const firstStore = new EventStore(databasePath);
      const firstController = new TaskController(firstStore);
      const alphaTaskId = submitToRepository(firstController, "repo_alpha");
      const betaTaskId = submitToRepository(firstController, "repo_beta");
      firstStore.close();

      const recoveryStore = new EventStore(databasePath);
      const recoveryController = new TaskController(recoveryStore);
      const recovery = recoveryController.recoverAfterRestart(Bun.randomUUIDv7());
      expect(recovery.status).toBe("accepted");

      const snapshot = recoveryController.snapshot();
      expect(snapshot.tasks.find((task) => task.id === alphaTaskId)?.state).toBe("paused");
      expect(snapshot.tasks.find((task) => task.id === betaTaskId)?.state).toBe("paused");
      expect(snapshot.activeTaskIds).toEqual({ repo_alpha: alphaTaskId, repo_beta: betaTaskId });
      recoveryStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
