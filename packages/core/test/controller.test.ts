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

function submit(controller: TaskController, id = Bun.randomUUIDv7()): string {
  const result = controller.handle({
    id,
    type: "task.submit",
    actor: "voice",
    expectedRevision: null,
    payload: spec,
  });
  if (result.status !== "accepted" || !result.taskId) throw new Error("Task submission failed");
  return result.taskId;
}

describe("TaskController", () => {
  test("runs one task and atomically starts the next queued task", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const firstTaskId = submit(controller);
      const secondTaskId = submit(controller);

      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(firstTaskId);
      expect(snapshot.queue).toEqual([secondTaskId]);

      const completion = controller.completeTask(
        Bun.randomUUIDv7(),
        firstTaskId,
        "The requested behavior was verified",
        [],
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
      recoveryStore.close();

      const replayStore = new EventStore(databasePath);
      const replayController = new TaskController(replayStore);
      snapshot = replayController.snapshot();
      expect(snapshot.tasks[0]?.state).toBe("paused");
      expect(snapshot.runs[0]?.state).toBe("interrupted");
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

  test("reacts to a coder question with a resumable awaiting-user state", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const awaiting = controller.awaitUserInput(
        Bun.randomUUIDv7(),
        taskId,
        "Which deployment target should I use?",
      );
      expect(awaiting.status).toBe("accepted");
      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(taskId);
      expect(snapshot.tasks[0]?.state).toBe("awaiting_user");
      expect(snapshot.runs[0]?.state).toBe("paused");
      expect(controller.eventsAfter().at(-1)?.type).toBe("task.awaitingUser");

      const resumed = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(resumed.status).toBe("accepted");
      snapshot = controller.snapshot();
      expect(snapshot.tasks[0]?.state).toBe("running");
      expect(snapshot.runs).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
