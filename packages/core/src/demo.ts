import { TaskController } from "./controller.ts";
import { EventStore } from "./event-store.ts";

const store = new EventStore();
const controller = new TaskController(store);

const initialSpec = {
  repositoryId: "repo_demo",
  objective: "Apply the requested behavior change",
  acceptanceCriteria: ["The changed behavior is verified"],
  constraints: ["Preserve existing user work"],
  attachmentIds: [],
  codingProfileId: "gpt-5.6-sol",
} as const;

const firstSubmission = controller.handle({
  id: Bun.randomUUIDv7(),
  type: "task.submit",
  actor: "voice",
  expectedRevision: null,
  payload: initialSpec,
});
if (firstSubmission.status !== "accepted" || !firstSubmission.taskId) {
  throw new Error("The first demo task was not accepted");
}
const firstTaskId = firstSubmission.taskId;

const secondSubmission = controller.handle({
  id: Bun.randomUUIDv7(),
  type: "task.submit",
  actor: "voice",
  expectedRevision: null,
  payload: {
    ...initialSpec,
    objective: "Run the queued follow-up",
  },
});
if (secondSubmission.status !== "accepted" || !secondSubmission.taskId) {
  throw new Error("The queued demo task was not accepted");
}

controller.handle({
  id: Bun.randomUUIDv7(),
  type: "task.requestPause",
  actor: "voice",
  expectedRevision: 1,
  payload: {
    taskId: firstTaskId,
    reason: "The user changed a load-bearing requirement",
  },
});
controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), firstTaskId);

controller.handle({
  id: Bun.randomUUIDv7(),
  type: "task.revise",
  actor: "voice",
  expectedRevision: 1,
  payload: {
    taskId: firstTaskId,
    spec: {
      ...initialSpec,
      acceptanceCriteria: [
        "The changed behavior is verified",
        "The revised requirement is represented",
      ],
      constraints: ["Preserve existing user work", "Use the revised architecture"],
    },
  },
});

controller.handle({
  id: Bun.randomUUIDv7(),
  type: "task.resume",
  actor: "voice",
  expectedRevision: 2,
  payload: { taskId: firstTaskId },
});
controller.completeTask(
  Bun.randomUUIDv7(),
  firstTaskId,
  "The revised task run completed",
  [],
);

const snapshot = controller.snapshot();
console.log(
  JSON.stringify(
    {
      sequence: snapshot.seq,
      activeTaskId: snapshot.activeTaskId,
      queue: snapshot.queue,
      tasks: snapshot.tasks.map((task) => ({
        id: task.id,
        state: task.state,
        revision: task.revision,
        runs: task.runIds.length,
      })),
      events: controller.eventsAfter().map((event) => ({
        seq: event.seq,
        type: event.type,
        taskId: event.taskId,
        runId: event.runId,
      })),
    },
    null,
    2,
  ),
);

store.close();
