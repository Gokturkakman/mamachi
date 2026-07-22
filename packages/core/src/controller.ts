import {
  parseCommand,
  type ActionResult,
  type Command,
  type EventPayload,
  type EventType,
  type NewDomainEvent,
  type TaskSpec,
} from "@mamachi/protocol";
import {
  applyEvent,
  replayEvents,
  snapshotState,
  type ControllerSnapshot,
  type ControllerState,
  type TaskRecord,
} from "./domain.ts";
import { EventStore, type CommandDecision } from "./event-store.ts";

export interface ControllerOptions {
  createId?: () => string;
  now?: () => string;
}

export class TaskController {
  readonly #store: EventStore;
  readonly #createId: () => string;
  readonly #now: () => string;
  #state: ControllerState;

  constructor(store: EventStore, options: ControllerOptions = {}) {
    this.#store = store;
    this.#createId = options.createId ?? (() => Bun.randomUUIDv7());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#state = replayEvents(store.readAfter());
  }

  handle(input: unknown): ActionResult {
    const command = parseCommand(input);
    const execution = this.#store.executeCommand(
      {
        id: command.id,
        type: command.type,
        actor: command.actor,
        expectedRevision: command.expectedRevision,
        payload: command.payload,
        createdAt: this.#now(),
      },
      () => this.#decide(command),
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  pauseAtSafeBoundary(signalId: string, taskId: string, reason = "safe tool boundary reached"): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: "internal.safeBoundaryReached",
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, reason },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (task.state !== "pause_requested" || !task.activeRunId) {
          return this.#reject("invalid_state", `Task ${taskId} is not waiting for a safe pause boundary`);
        }
        const event = this.#event(
          "task.paused",
          { runId: task.activeRunId, reason },
          signalId,
          task,
          task.activeRunId,
        );
        return this.#accept([event], task.id);
      },
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  completeTask(signalId: string, taskId: string, summary: string, evidenceIds: string[]): ActionResult {
    return this.#finishTask(signalId, taskId, "completed", summary, evidenceIds);
  }

  failTask(signalId: string, taskId: string, error: string): ActionResult {
    return this.#finishTask(signalId, taskId, "failed", error, []);
  }

  recoverAfterRestart(recoveryId: string): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: recoveryId,
        type: "internal.recoverAfterRestart",
        actor: "controller",
        expectedRevision: null,
        payload: {},
        createdAt: this.#now(),
      },
      () => {
        const taskId = this.#state.activeTaskId;
        if (!taskId) return this.#reject("nothing_to_recover", "No task owns the active slot");
        const task = this.#requiredTask(taskId);
        if (!(task.state === "running" || task.state === "pause_requested") || !task.activeRunId) {
          return this.#reject("nothing_to_recover", `Task ${taskId} is already ${task.state}`);
        }

        const runId = task.activeRunId;
        const interrupted = this.#event(
          "run.interrupted",
          { runId, reason: "daemon restarted with an unfinished run" },
          recoveryId,
          task,
          runId,
        );
        const paused = this.#event(
          "task.paused",
          { runId, reason: "recovery requires explicit resume" },
          recoveryId,
          task,
          runId,
        );
        return this.#accept([interrupted, paused], task.id);
      },
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  snapshot(): ControllerSnapshot {
    return snapshotState(this.#state);
  }

  eventsAfter(afterSeq = 0) {
    return this.#store.readAfter(afterSeq);
  }

  #decide(command: Command): CommandDecision {
    switch (command.type) {
      case "task.submit":
        return this.#submit(command);
      case "task.requestPause":
        return this.#requestPause(command);
      case "task.revise":
        return this.#revise(command);
      case "task.resume":
        return this.#resume(command);
      case "task.cancel":
        return this.#cancel(command);
      case "queue.move":
        return this.#moveQueue(command);
    }
  }

  #submit(command: Extract<Command, { type: "task.submit" }>): CommandDecision {
    const taskId = this.#createId();
    const spec = structuredClone(command.payload) as TaskSpec;
    const created = this.#event(
      "task.created",
      { spec, revision: 1 },
      command.id,
      { id: taskId, repositoryId: spec.repositoryId },
    );
    const enqueued = this.#event(
      "task.enqueued",
      { position: this.#state.queue.length },
      command.id,
      { id: taskId, repositoryId: spec.repositoryId },
    );
    const events: NewDomainEvent[] = [created, enqueued];

    if (!this.#state.activeTaskId) {
      events.push(
        this.#event(
          "task.started",
          { runId: this.#createId(), revision: 1 },
          command.id,
          { id: taskId, repositoryId: spec.repositoryId },
        ),
      );
    }

    return this.#accept(events, taskId);
  }

  #requestPause(command: Extract<Command, { type: "task.requestPause" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (task.id !== this.#state.activeTaskId || task.state !== "running") {
      return this.#reject("invalid_state", `Task ${task.id} is not the running task`);
    }

    const event = this.#event(
      "task.pauseRequested",
      { reason: command.payload.reason },
      command.id,
      task,
      task.activeRunId ?? undefined,
    );
    return this.#accept([event], task.id);
  }

  #revise(command: Extract<Command, { type: "task.revise" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (task.state !== "paused" || task.id !== this.#state.activeTaskId) {
      return this.#reject("invalid_state", `Task ${task.id} must be paused before revision`);
    }
    if (command.payload.spec.repositoryId !== task.repositoryId) {
      return this.#reject("repository_immutable", "A task revision cannot retarget its repository");
    }

    const revision = task.revision + 1;
    const event = this.#event(
      "task.specRevised",
      {
        previousRevision: task.revision,
        revision,
        spec: structuredClone(command.payload.spec) as TaskSpec,
      },
      command.id,
      task,
    );
    return this.#accept([event], task.id);
  }

  #resume(command: Extract<Command, { type: "task.resume" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (task.state !== "paused" || task.id !== this.#state.activeTaskId) {
      return this.#reject("invalid_state", `Task ${task.id} does not own a paused active slot`);
    }

    const runId = this.#createId();
    const event = this.#event(
      "task.resumed",
      { runId, revision: task.revision },
      command.id,
      task,
      runId,
    );
    return this.#accept([event], task.id);
  }

  #cancel(command: Extract<Command, { type: "task.cancel" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (["completed", "failed", "cancelled"].includes(task.state)) {
      return this.#reject("terminal_task", `Task ${task.id} is already ${task.state}`);
    }

    const wasActive = task.id === this.#state.activeTaskId;
    const events: NewDomainEvent[] = [
      this.#event(
        "task.cancelled",
        { reason: command.payload.reason },
        command.id,
        task,
        task.activeRunId ?? undefined,
      ),
    ];
    if (wasActive) {
      const startNext = this.#startNextEvent(command.id);
      if (startNext) events.push(startNext);
    }
    return this.#accept(events, task.id);
  }

  #moveQueue(command: Extract<Command, { type: "queue.move" }>): CommandDecision {
    const { taskId, operation, anchorTaskId } = command.payload;
    const task = this.#state.tasks.get(taskId);
    if (!task || task.state !== "queued" || !this.#state.queue.includes(taskId)) {
      return this.#reject("not_queued", `Task ${taskId} is not queued`);
    }

    const queue = this.#state.queue.filter((id) => id !== taskId);
    if (operation === "move_first") {
      if (anchorTaskId !== null) return this.#reject("invalid_anchor", "move_first does not accept an anchor");
      queue.unshift(taskId);
    } else if (operation === "move_last") {
      if (anchorTaskId !== null) return this.#reject("invalid_anchor", "move_last does not accept an anchor");
      queue.push(taskId);
    } else {
      if (!anchorTaskId || anchorTaskId === taskId) {
        return this.#reject("invalid_anchor", `${operation} requires a different queued anchor`);
      }
      const anchorIndex = queue.indexOf(anchorTaskId);
      if (anchorIndex === -1) return this.#reject("invalid_anchor", `Anchor task ${anchorTaskId} is not queued`);
      queue.splice(operation === "move_before" ? anchorIndex : anchorIndex + 1, 0, taskId);
    }

    const event = this.#event("queue.reordered", { taskIds: queue }, command.id, task);
    return this.#accept([event], task.id);
  }

  #finishTask(
    signalId: string,
    taskId: string,
    outcome: "completed" | "failed",
    detail: string,
    evidenceIds: string[],
  ): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: `internal.task.${outcome}`,
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, detail, evidenceIds },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (task.id !== this.#state.activeTaskId || !task.activeRunId) {
          return this.#reject("invalid_state", `Task ${task.id} has no active run`);
        }
        if (!(task.state === "running" || task.state === "pause_requested")) {
          return this.#reject("invalid_state", `Task ${task.id} cannot finish from ${task.state}`);
        }

        const runId = task.activeRunId;
        const finished =
          outcome === "completed"
            ? this.#event(
                "task.completed",
                { runId, summary: detail, evidenceIds },
                signalId,
                task,
                runId,
              )
            : this.#event("task.failed", { runId, error: detail }, signalId, task, runId);
        const events: NewDomainEvent[] = [finished];
        const startNext = this.#startNextEvent(signalId);
        if (startNext) events.push(startNext);
        return this.#accept(events, task.id);
      },
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  #startNextEvent(correlationId: string): NewDomainEvent<"task.started"> | null {
    const nextTaskId = this.#state.queue[0];
    if (!nextTaskId) return null;
    const nextTask = this.#requiredTask(nextTaskId);
    const runId = this.#createId();
    return this.#event(
      "task.started",
      { runId, revision: nextTask.revision },
      correlationId,
      nextTask,
      runId,
    );
  }

  #requiredTask(taskId: string): TaskRecord {
    const task = this.#state.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} does not exist`);
    return task;
  }

  #checkRevision(task: TaskRecord, expectedRevision: number): CommandDecision | null {
    if (task.revision === expectedRevision) return null;
    return {
      result: {
        status: "conflict",
        currentRevision: task.revision,
        explanation: `Task ${task.id} is at revision ${task.revision}, not ${expectedRevision}`,
      },
      events: [],
    };
  }

  #event<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    correlationId: string,
    task: Pick<TaskRecord, "id" | "repositoryId">,
    runId?: string,
  ): NewDomainEvent<T> {
    return {
      version: 1,
      id: this.#createId(),
      at: this.#now(),
      type,
      actor: "controller",
      projectId: task.repositoryId,
      taskId: task.id,
      ...(runId ? { runId } : {}),
      correlationId,
      causedBy: correlationId,
      payload,
    } as NewDomainEvent<T>;
  }

  #accept(events: NewDomainEvent[], taskId?: string): CommandDecision {
    const event = events.at(-1);
    if (!event) throw new Error("Accepted decisions require at least one event");
    return {
      result: {
        status: "accepted",
        eventId: event.id,
        ...(taskId ? { taskId } : {}),
      },
      events,
    };
  }

  #reject(code: string, explanation: string): CommandDecision {
    return {
      result: { status: "rejected", code, explanation },
      events: [],
    };
  }
}
