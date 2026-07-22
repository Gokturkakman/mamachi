export { TaskController, type ControllerOptions } from "./controller.ts";
export {
  applyEvent,
  assertStateInvariants,
  createEmptyState,
  replayEvents,
  snapshotState,
  type ControllerSnapshot,
  type ControllerState,
  type RunRecord,
  type RunState,
  type SpecHistoryEntry,
  type TaskRecord,
  type TaskState,
} from "./domain.ts";
export {
  EventStore,
  type CommandDecision,
  type CommandExecution,
  type CommandRecord,
} from "./event-store.ts";
export {
  MamachiIpcServer,
  type DaemonHooks,
  type IpcServerOptions,
} from "./ipc-server.ts";
export { OmpRunner, type OmpRunnerOptions } from "./omp-runner.ts";
export { RealtimeBridge } from "./realtime-bridge.ts";
export {
  FactProjector,
  type FactActivity,
  type FactSnapshot,
  type ImplementationState,
  type TaskFacts,
  type TaskPhase,
  type VerificationState,
} from "./fact-projector.ts";
export {
  OmpObserverBackend,
  PassiveObserver,
  type ObserverBackend,
  type ObserverDraft,
  type ObserverPacket,
  type PassiveObserverOptions,
} from "./observer.ts";
export {
  WorkspaceGuard,
  type EditorDocumentState,
  type WorkspaceConflict,
  type WorkspaceGuardDecision,
  type WorkspaceMutation,
} from "./workspace-guard.ts";
