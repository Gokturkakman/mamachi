import type { DomainEvent, TaskSpec } from "@mamachi/protocol";

export type TaskState =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export type RunState = "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

export interface TaskRecord {
  id: string;
  repositoryId: string;
  state: TaskState;
  spec: TaskSpec;
  revision: number;
  activeRunId: string | null;
  runIds: string[];
  createdAt: string;
  updatedAt: string;
  terminalSummary: string | null;
}

export interface RunRecord {
  id: string;
  taskId: string;
  taskRevision: number;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
}

export interface ControllerState {
  seq: number;
  activeTaskId: string | null;
  queue: string[];
  tasks: Map<string, TaskRecord>;
  runs: Map<string, RunRecord>;
}

export interface ControllerSnapshot {
  seq: number;
  activeTaskId: string | null;
  queue: string[];
  tasks: TaskRecord[];
  runs: RunRecord[];
}

export function createEmptyState(): ControllerState {
  return {
    seq: 0,
    activeTaskId: null,
    queue: [],
    tasks: new Map(),
    runs: new Map(),
  };
}

function requiredTask(state: ControllerState, taskId: string): TaskRecord {
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`Event references missing task ${taskId}`);
  return task;
}

function requiredRun(state: ControllerState, runId: string): RunRecord {
  const run = state.runs.get(runId);
  if (!run) throw new Error(`Event references missing run ${runId}`);
  return run;
}

function requireTaskId(event: DomainEvent): string {
  if (!event.taskId) throw new Error(`${event.type} is missing taskId`);
  return event.taskId;
}

function removeFromQueue(state: ControllerState, taskId: string): void {
  const index = state.queue.indexOf(taskId);
  if (index !== -1) state.queue.splice(index, 1);
}

export function applyEvent(state: ControllerState, event: DomainEvent): void {
  if (event.seq !== state.seq + 1) {
    throw new Error(`Non-contiguous event sequence: expected ${state.seq + 1}, received ${event.seq}`);
  }

  switch (event.type) {
    case "task.created": {
      const taskId = requireTaskId(event);
      if (state.tasks.has(taskId)) throw new Error(`Task ${taskId} already exists`);
      state.tasks.set(taskId, {
        id: taskId,
        repositoryId: event.payload.spec.repositoryId,
        state: "queued",
        spec: event.payload.spec,
        revision: event.payload.revision,
        activeRunId: null,
        runIds: [],
        createdAt: event.at,
        updatedAt: event.at,
        terminalSummary: null,
      });
      break;
    }
    case "task.enqueued": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      removeFromQueue(state, taskId);
      const position = Math.min(event.payload.position, state.queue.length);
      state.queue.splice(position, 0, taskId);
      task.state = "queued";
      task.updatedAt = event.at;
      break;
    }
    case "task.started":
    case "task.resumed": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      const runId = event.payload.runId;
      if (state.activeTaskId && state.activeTaskId !== taskId) {
        throw new Error(`Cannot start ${taskId}; ${state.activeTaskId} owns the active slot`);
      }
      if (state.runs.has(runId)) throw new Error(`Run ${runId} already exists`);
      removeFromQueue(state, taskId);
      task.state = "running";
      task.activeRunId = runId;
      task.runIds.push(runId);
      task.updatedAt = event.at;
      state.runs.set(runId, {
        id: runId,
        taskId,
        taskRevision: event.payload.revision,
        state: "running",
        startedAt: event.at,
        endedAt: null,
      });
      state.activeTaskId = taskId;
      break;
    }
    case "task.pauseRequested": {
      const task = requiredTask(state, requireTaskId(event));
      task.state = "pause_requested";
      task.updatedAt = event.at;
      break;
    }
    case "task.paused": {
      const task = requiredTask(state, requireTaskId(event));
      const run = requiredRun(state, event.payload.runId);
      if (run.state !== "interrupted") run.state = "paused";
      run.endedAt = event.at;
      task.state = "paused";
      task.activeRunId = null;
      task.updatedAt = event.at;
      break;
    }
    case "task.specRevised": {
      const task = requiredTask(state, requireTaskId(event));
      task.spec = event.payload.spec;
      task.revision = event.payload.revision;
      task.updatedAt = event.at;
      break;
    }
    case "task.completed": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      const run = requiredRun(state, event.payload.runId);
      run.state = "completed";
      run.endedAt = event.at;
      task.state = "completed";
      task.activeRunId = null;
      task.updatedAt = event.at;
      task.terminalSummary = event.payload.summary;
      removeFromQueue(state, taskId);
      if (state.activeTaskId === taskId) state.activeTaskId = null;
      break;
    }
    case "task.failed": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      const run = requiredRun(state, event.payload.runId);
      run.state = "failed";
      run.endedAt = event.at;
      task.state = "failed";
      task.activeRunId = null;
      task.updatedAt = event.at;
      task.terminalSummary = event.payload.error;
      removeFromQueue(state, taskId);
      if (state.activeTaskId === taskId) state.activeTaskId = null;
      break;
    }
    case "task.cancelled": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      if (task.activeRunId) {
        const run = requiredRun(state, task.activeRunId);
        run.state = "cancelled";
        run.endedAt = event.at;
      }
      task.state = "cancelled";
      task.activeRunId = null;
      task.updatedAt = event.at;
      task.terminalSummary = event.payload.reason;
      removeFromQueue(state, taskId);
      if (state.activeTaskId === taskId) state.activeTaskId = null;
      break;
    }
    case "run.interrupted": {
      const run = requiredRun(state, event.payload.runId);
      run.state = "interrupted";
      run.endedAt = event.at;
      break;
    }
    case "queue.reordered": {
      state.queue = [...event.payload.taskIds];
      break;
    }
  }

  state.seq = event.seq;
  assertStateInvariants(state);
}

export function replayEvents(events: readonly DomainEvent[]): ControllerState {
  const state = createEmptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

export function snapshotState(state: ControllerState): ControllerSnapshot {
  return {
    seq: state.seq,
    activeTaskId: state.activeTaskId,
    queue: [...state.queue],
    tasks: [...state.tasks.values()].map((task) => structuredClone(task)),
    runs: [...state.runs.values()].map((run) => structuredClone(run)),
  };
}

export function assertStateInvariants(state: ControllerState): void {
  const queued = new Set(state.queue);
  if (queued.size !== state.queue.length) throw new Error("Queue contains duplicate tasks");

  for (const taskId of state.queue) {
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Queue references missing task ${taskId}`);
    if (task.state !== "queued") throw new Error(`Queue contains non-queued task ${taskId}`);
  }

  if (state.activeTaskId) {
    const task = state.tasks.get(state.activeTaskId);
    if (!task) throw new Error(`Active slot references missing task ${state.activeTaskId}`);
    if (!(["running", "pause_requested", "paused", "awaiting_user"] as TaskState[]).includes(task.state)) {
      throw new Error(`Active task ${task.id} has invalid state ${task.state}`);
    }
    if (queued.has(task.id)) throw new Error(`Active task ${task.id} is also queued`);
  }

  for (const task of state.tasks.values()) {
    if (task.activeRunId) {
      const run = state.runs.get(task.activeRunId);
      if (!run) throw new Error(`Task ${task.id} references missing active run ${task.activeRunId}`);
      if (run.taskId !== task.id) throw new Error(`Run ${run.id} belongs to a different task`);
      if (!(["running", "interrupted"] as RunState[]).includes(run.state)) {
        throw new Error(`Task ${task.id} points to inactive run ${run.id}`);
      }
      if (run.state === "interrupted" && !(task.state === "running" || task.state === "pause_requested")) {
        throw new Error(`Interrupted run ${run.id} is attached to task state ${task.state}`);
      }
    }
  }
}
