import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import {
  ExternalCliRunner,
  type ExternalCliRunnerOptions,
} from "./external-cli-runner.ts";
import {
  defaultRuntimeSettings,
  type CodingBackend,
  type RuntimeSettings,
} from "./model-router.ts";
import { OmpRunner, type OmpRunnerOptions } from "./omp-runner.ts";
import type { EditorDocumentState } from "./workspace-guard.ts";

interface CodingBackendRunner {
  configure(settings: RuntimeSettings): void;
  updateEditorState(state: EditorDocumentState): void;
  askCoder(taskId: string, question: string): Promise<boolean>;
  steer(taskId: string, clarification: string): Promise<boolean>;
  followUp(taskId: string, addition: string): Promise<boolean>;
  handleEvents(events: readonly DomainEvent[]): void;
  dispose(): Promise<void>;
}

export interface CodingRunnerOptions
  extends Omit<OmpRunnerOptions, "onSessionBound" | "runtimeSettings" | "workspaceGuard"> {
  onSessionBound?: (
    taskId: string,
    runId: string,
    backend: CodingBackend,
    sessionId: string,
    sessionFile: string | null,
  ) => Promise<ActionResult>;
  runtimeSettings?: RuntimeSettings;
  codexExecutable?: string;
  claudeExecutable?: string;
}

interface Lane {
  runners: Record<CodingBackend, CodingBackendRunner>;
  activeBackend: CodingBackend | null;
}

/**
 * One task runs per repository at a time (the controller enforces this), but different
 * repositories run concurrently. Each repositoryId therefore gets its own lane: a full,
 * independent set of backend runners, so a session/stream/workspace guard owned by one
 * repository's OmpRunner or ExternalCliRunner can never be touched by another repository's
 * task. Lanes are created lazily on first use and live for the daemon's lifetime, same as
 * the single runner set did before.
 */
export class CodingRunner {
  readonly #options: CodingRunnerOptions;
  readonly #lanes = new Map<string, Lane>();
  #runtimeSettings: RuntimeSettings;

  constructor(options: CodingRunnerOptions) {
    this.#options = options;
    this.#runtimeSettings = options.runtimeSettings ?? defaultRuntimeSettings;
  }

  configure(settings: RuntimeSettings): void {
    this.#runtimeSettings = settings;
    for (const lane of this.#lanes.values()) {
      for (const runner of Object.values(lane.runners)) runner.configure(settings);
    }
  }

  updateEditorState(state: EditorDocumentState): void {
    for (const lane of this.#lanes.values()) {
      for (const runner of Object.values(lane.runners)) runner.updateEditorState(state);
    }
  }

  async askCoder(taskId: string, question: string): Promise<boolean> {
    const lane = this.#laneForTask(taskId);
    const runner = lane?.activeBackend ? lane.runners[lane.activeBackend] : null;
    return runner ? runner.askCoder(taskId, question) : false;
  }

  async steer(taskId: string, clarification: string): Promise<boolean> {
    const lane = this.#laneForTask(taskId);
    const runner = lane?.activeBackend ? lane.runners[lane.activeBackend] : null;
    return runner ? runner.steer(taskId, clarification) : false;
  }

  async followUp(taskId: string, addition: string): Promise<boolean> {
    const lane = this.#laneForTask(taskId);
    const runner = lane?.activeBackend ? lane.runners[lane.activeBackend] : null;
    return runner ? runner.followUp(taskId, addition) : false;
  }

  handleEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      if (!event.taskId) continue;
      const task = this.#options.getTask(event.taskId);
      if (!task) continue;
      const lane = this.#lane(task.repositoryId);
      if (event.type === "task.started" || event.type === "task.resumed") {
        lane.activeBackend = task.codingSession?.backend ?? this.#runtimeSettings.codingBackend;
      }
      if (lane.activeBackend) lane.runners[lane.activeBackend].handleEvents([event]);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#lanes.values()].flatMap((lane) => Object.values(lane.runners).map((runner) => runner.dispose())),
    );
    this.#lanes.clear();
  }

  #laneForTask(taskId: string): Lane | undefined {
    const repositoryId = this.#options.getTask(taskId)?.repositoryId;
    return repositoryId ? this.#lanes.get(repositoryId) : undefined;
  }

  #lane(repositoryId: string): Lane {
    const existing = this.#lanes.get(repositoryId);
    if (existing) return existing;
    const lane: Lane = { runners: this.#createRunners(), activeBackend: null };
    this.#lanes.set(repositoryId, lane);
    return lane;
  }

  #createRunners(): Record<CodingBackend, CodingBackendRunner> {
    const options = this.#options;
    const sharedExternal: Omit<ExternalCliRunnerOptions, "backend" | "executable" | "workspaceGuard"> = {
      getTask: options.getTask,
      ...(options.getArtifacts ? { getArtifacts: options.getArtifacts } : {}),
      emit: options.emit,
      onSafePause: options.onSafePause,
      onAuthorizeTool: options.onAuthorizeTool,
      onWorkspaceConflict: options.onWorkspaceConflict,
      onRecordEvidence: options.onRecordEvidence,
      onComplete: options.onComplete,
      onFail: options.onFail,
      onNeedInput: options.onNeedInput,
      ...(options.onSessionBound ? { onSessionBound: options.onSessionBound } : {}),
      runtimeSettings: this.#runtimeSettings,
    };
    return {
      omp: new OmpRunner({
        getTask: options.getTask,
        ...(options.getArtifacts ? { getArtifacts: options.getArtifacts } : {}),
        emit: options.emit,
        onSafePause: options.onSafePause,
        onAuthorizeTool: options.onAuthorizeTool,
        onWorkspaceConflict: options.onWorkspaceConflict,
        onRecordEvidence: options.onRecordEvidence,
        onComplete: options.onComplete,
        onFail: options.onFail,
        onNeedInput: options.onNeedInput,
        ...(options.onSessionBound ? { onSessionBound: options.onSessionBound } : {}),
        ...(options.authStorage ? { authStorage: options.authStorage } : {}),
        ...(options.createSession ? { createSession: options.createSession } : {}),
        ...(options.openSession ? { openSession: options.openSession } : {}),
        runtimeSettings: this.#runtimeSettings,
      }),
      codex: new ExternalCliRunner({
        ...sharedExternal,
        backend: "codex",
        ...(options.codexExecutable ? { executable: options.codexExecutable } : {}),
      }),
      claude: new ExternalCliRunner({
        ...sharedExternal,
        backend: "claude",
        ...(options.claudeExecutable ? { executable: options.claudeExecutable } : {}),
      }),
    };
  }
}
