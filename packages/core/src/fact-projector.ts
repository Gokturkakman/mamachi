import type { ArtifactStore, ObserverInterpretation } from "./artifact-store.ts";
import type { ControllerSnapshot, TaskRecord } from "./domain.ts";

export type TaskPhase =
  | "queued"
  | "understanding"
  | "execution"
  | "implementation"
  | "verification"
  | "awaiting_user"
  | "paused"
  | "complete"
  | "failed"
  | "cancelled";

export type ImplementationState = "pending" | "observed" | "changed" | "complete";
export type VerificationState = "not_required" | "pending" | "passed" | "failed";

export interface FactActivity {
  artifactId: string;
  kind: "tool_result" | "file_change" | "verification";
  summary: string;
  successful: boolean;
  at: string;
}

export interface TaskFacts {
  taskId: string;
  phase: TaskPhase;
  progress: number;
  currentStep: string;
  implementationState: ImplementationState;
  verificationState: VerificationState;
  changedFiles: string[];
  verificationSummaries: string[];
  recentActivity: FactActivity[];
  evidenceIds: string[];
  observerInterpretation: ObserverInterpretation | null;
  groundedAt: string;
  groundedAtSeq: number;
}

export interface FactSnapshot {
  seq: number;
  activeTask: TaskFacts | null;
  tasks: TaskFacts[];
}

export class FactProjector {
  readonly #artifacts: ArtifactStore;

  constructor(artifacts: ArtifactStore) {
    this.#artifacts = artifacts;
  }

  project(snapshot: ControllerSnapshot): FactSnapshot {
    const tasks = snapshot.tasks.map((task) => this.projectTask(task, snapshot.seq));
    return {
      seq: snapshot.seq,
      activeTask: tasks.find((facts) => facts.taskId === snapshot.activeTaskId) ?? null,
      tasks,
    };
  }

  projectTask(task: TaskRecord, seq: number): TaskFacts {
    const evidence = this.#artifacts.listEvidenceForTask(task.id);
    const successful = evidence.filter((artifact) => artifact.successful);
    const fileChanges = successful.filter((artifact) => artifact.kind === "file_change");
    const lastFileChangeOrdinal = Math.max(0, ...fileChanges.map((artifact) => artifact.ordinal));
    const verificationAfterChange = evidence.filter(
      (artifact) => artifact.kind === "verification" && artifact.ordinal > lastFileChangeOrdinal,
    );
    const latestVerification = verificationAfterChange.at(-1);
    const changedFiles = fileChanges
      .flatMap((artifact) => {
        const paths = artifact.payload["changedFiles"];
        return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
      })
      .filter((path, index, paths) => paths.indexOf(path) === index);
    const latestEvidence = evidence.at(-1);
    const implementationState: ImplementationState =
      task.state === "completed"
        ? "complete"
        : fileChanges.length > 0
          ? "changed"
          : successful.length > 0
            ? "observed"
            : "pending";
    const verificationState: VerificationState =
      fileChanges.length === 0
        ? "not_required"
        : !latestVerification
          ? "pending"
          : latestVerification.successful
            ? "passed"
            : "failed";
    const runningPhase = this.#runningPhase(fileChanges.length, successful.length, verificationState);
    const phase: TaskPhase =
      task.state === "queued"
        ? "queued"
        : task.state === "awaiting_user"
          ? "awaiting_user"
          : task.state === "paused" || task.state === "pause_requested"
            ? "paused"
            : task.state === "completed"
              ? "complete"
              : task.state === "failed"
                ? "failed"
                : task.state === "cancelled"
                  ? "cancelled"
                  : runningPhase;
    const progress = this.#progress(task, runningPhase, verificationState, fileChanges.length, successful.length);
    return {
      taskId: task.id,
      phase,
      progress,
      currentStep: this.#currentStep(task, phase, latestEvidence?.summary, verificationState),
      implementationState,
      verificationState,
      changedFiles,
      verificationSummaries: verificationAfterChange.slice(-5).map((artifact) => artifact.summary),
      recentActivity: evidence.slice(-8).map((artifact) => ({
        artifactId: artifact.id,
        kind: artifact.kind,
        summary: artifact.summary,
        successful: artifact.successful,
        at: artifact.createdAt,
      })),
      evidenceIds: [...task.evidenceIds],
      observerInterpretation: this.#artifacts.latestObserverInterpretation(task.id),
      groundedAt: latestEvidence?.createdAt ?? task.updatedAt,
      groundedAtSeq: seq,
    };
  }

  #runningPhase(
    fileChangeCount: number,
    successfulEvidenceCount: number,
    verificationState: VerificationState,
  ): TaskPhase {
    if (fileChangeCount > 0 && verificationState !== "pending") return "verification";
    if (fileChangeCount > 0) return "implementation";
    if (successfulEvidenceCount > 0) return "execution";
    return "understanding";
  }

  #progress(
    task: TaskRecord,
    runningPhase: TaskPhase,
    verificationState: VerificationState,
    fileChangeCount: number,
    successfulEvidenceCount: number,
  ): number {
    if (task.state === "queued") return 0;
    if (task.state === "completed") return 100;
    if (task.state === "failed" || task.state === "cancelled") return 100;
    let progress =
      runningPhase === "understanding"
        ? 15
        : runningPhase === "execution"
          ? 35
          : runningPhase === "implementation"
            ? 65
            : verificationState === "passed"
              ? 90
              : 75;
    if (fileChangeCount === 0 && successfulEvidenceCount > 2) progress = 50;
    if (task.state === "awaiting_user" || task.state === "paused" || task.state === "pause_requested") {
      progress = Math.max(10, progress);
    }
    return progress;
  }

  #currentStep(
    task: TaskRecord,
    phase: TaskPhase,
    latestEvidenceSummary: string | undefined,
    verificationState: VerificationState,
  ): string {
    if (phase === "queued") return "Waiting in the task queue";
    if (phase === "awaiting_user") {
      return task.workspaceConflict
        ? `Waiting to reconcile user changes in ${task.workspaceConflict.paths.join(", ")}`
        : "Waiting for a user decision";
    }
    if (phase === "paused") return "Paused at a safe boundary";
    if (phase === "complete") return task.terminalSummary ?? "Completed with grounded evidence";
    if (phase === "failed") return task.terminalSummary ?? "Task failed";
    if (phase === "cancelled") return task.terminalSummary ?? "Task cancelled";
    if (verificationState === "failed") return "Fixing a failed verification";
    if (verificationState === "passed") return "Verification passed; preparing the result";
    return latestEvidenceSummary ?? "Understanding the task and repository";
  }
}
