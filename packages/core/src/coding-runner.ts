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

export class CodingRunner {
  readonly #options: CodingRunnerOptions;
  readonly #runners: Record<CodingBackend, CodingBackendRunner>;
  #runtimeSettings: RuntimeSettings;
  #activeBackend: CodingBackend | null = null;

  constructor(options: CodingRunnerOptions) {
    this.#options = options;
    this.#runtimeSettings = options.runtimeSettings ?? defaultRuntimeSettings;
    const sharedExternal: Omit<
      ExternalCliRunnerOptions,
      "backend" | "executable" | "workspaceGuard"
    > = {
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
    this.#runners = {
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

  configure(settings: RuntimeSettings): void {
    this.#runtimeSettings = settings;
    for (const runner of Object.values(this.#runners)) runner.configure(settings);
  }

  updateEditorState(state: EditorDocumentState): void {
    for (const runner of Object.values(this.#runners)) runner.updateEditorState(state);
  }

  async askCoder(taskId: string, question: string): Promise<boolean> {
    const runner = this.#activeBackend ? this.#runners[this.#activeBackend] : null;
    return runner ? runner.askCoder(taskId, question) : false;
  }

  async steer(taskId: string, clarification: string): Promise<boolean> {
    const runner = this.#activeBackend ? this.#runners[this.#activeBackend] : null;
    return runner ? runner.steer(taskId, clarification) : false;
  }

  async followUp(taskId: string, addition: string): Promise<boolean> {
    const runner = this.#activeBackend ? this.#runners[this.#activeBackend] : null;
    return runner ? runner.followUp(taskId, addition) : false;
  }

  handleEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      if ((event.type === "task.started" || event.type === "task.resumed") && event.taskId) {
        const task = this.#options.getTask(event.taskId);
        this.#activeBackend = task?.codingSession?.backend ?? this.#runtimeSettings.codingBackend;
      }
      if (this.#activeBackend) this.#runners[this.#activeBackend].handleEvents([event]);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(Object.values(this.#runners).map((runner) => runner.dispose()));
    this.#activeBackend = null;
  }
}
