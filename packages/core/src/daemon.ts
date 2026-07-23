import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MamachiIpcServer } from "./ipc-server.ts";
import { OmpRunner } from "./omp-runner.ts";
import { RealtimeBridge } from "./realtime-bridge.ts";
import { defaultRuntimeSettings, type RuntimeSettings } from "./model-router.ts";
import { MacComputerController } from "./computer-control.ts";
import { OmpObserverBackend, PassiveObserver } from "./observer.ts";
import { VoiceBriefStore } from "./voice-brief-store.ts";

const token = process.env["MAMACHI_TOKEN"] ?? Bun.randomUUIDv7();
const port = Number.parseInt(process.env["MAMACHI_PORT"] ?? "47821", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("MAMACHI_PORT must be a valid TCP port");
}

const databasePath = resolve(process.env["MAMACHI_STATE_PATH"] ?? ".mamachi/demo.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const connectionPath = process.env["MAMACHI_CONNECTION_PATH"]
  ? resolve(process.env["MAMACHI_CONNECTION_PATH"])
  : null;

const encryptionKey = process.env["MAMACHI_ENCRYPTION_KEY"] ?? null;
const codingProviderKeys = {
  anthropic: process.env["ANTHROPIC_API_KEY"],
  openai: process.env["OPENAI_API_KEY"],
  google: process.env["GEMINI_API_KEY"],
};
const realtimeDevelopmentApiKey = codingProviderKeys.openai;
const authStorage = await discoverAuthStorage();
for (const [provider, apiKey] of Object.entries(codingProviderKeys)) {
  if (apiKey) authStorage.setRuntimeApiKey(provider, apiKey);
}
delete process.env["MAMACHI_ENCRYPTION_KEY"];
delete process.env["MAMACHI_TOKEN"];
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["OPENAI_API_KEY"];
delete process.env["GEMINI_API_KEY"];
const briefStore = new VoiceBriefStore(databasePath, encryptionKey);

let runner: OmpRunner | null = null;
let realtime: RealtimeBridge | null = null;
let observer: PassiveObserver | null = null;
let observerBackend: OmpObserverBackend | null = null;
const initialRuntimeSettings: RuntimeSettings = {
  ...defaultRuntimeSettings,
  primaryModel: process.env["MAMACHI_CODING_MODEL"] ?? defaultRuntimeSettings.primaryModel,
};
let runtimeSettings = initialRuntimeSettings;
const computerController = new MacComputerController({
  capabilities: initialRuntimeSettings.computerCapabilities,
});
const daemon = new MamachiIpcServer({
  token,
  port,
  databasePath,
  initialWorkspace: process.env["MAMACHI_WORKSPACE"] ?? process.cwd(),
  encryptionKey,
  hooks: {
    onAudioInput: (pcm) => realtime?.appendAudio(pcm),
    onContextCaptured: (context) => realtime?.captureContext(context),
    onContextRemoved: (id) => realtime?.discardContext(id),
    onEditorState: (state) => runner?.updateEditorState(state),
    onTaskEvents: async (events) => {
      realtime?.handleTaskEvents(events);
      await runner?.handleEvents(events);
      const taskIds = [
        ...new Set(
          events.flatMap((event) => {
            if (!event.taskId) return [];
            if (
              event.type === "task.completed" ||
              event.type === "task.failed" ||
              event.type === "task.awaitingUser" ||
              (event.type === "artifact.created" &&
                (event.payload.kind === "file_change" || event.payload.kind === "verification"))
            ) {
              return [event.taskId];
            }
            return [];
          }),
        ),
      ];
      for (const taskId of taskIds) {
        const task = daemon.snapshot().tasks.find((candidate) => candidate.id === taskId);
        const facts = daemon.taskFacts(taskId);
        const runId = task?.activeRunId ?? task?.runIds.at(-1);
        if (!task || !facts || !runId) continue;
        observer?.observe({
          taskId,
          runId,
          repository: task.repositoryId,
          objective: task.spec.objective,
          taskState: task.state,
          terminalSummary: task.terminalSummary,
          facts,
        });
      }
    },
    onSettingsUpdate: (settings) => {
      runtimeSettings = settings;
      runner?.configure(settings);
      observerBackend?.configure(process.env["MAMACHI_OBSERVER_MODEL"] ?? settings.fastModel);
      computerController.configure(settings.computerCapabilities);
      realtime?.refreshComputerControlConfiguration();
    },
    onVoiceConnect: (apiKey) => realtime?.connect(apiKey),
    onVoiceDisconnect: () => realtime?.disconnect(),
    onVoiceEngagement: (engaged, playback) => realtime?.setEngaged(engaged, playback),
    onVoiceInterrupt: (playback) => realtime?.interrupt(playback),
    onVoiceText: (text) => realtime?.sendText(text),
    onVoiceMode: (mode) => realtime?.setResponseMode(mode),
  },
});

realtime = new RealtimeBridge({
  ...(realtimeDevelopmentApiKey ? { apiKey: realtimeDevelopmentApiKey } : {}),
  getWorkspace: () => daemon.workspace,
  getAvailableWorkspaces: () => [daemon.workspace],
  getCodingProfiles: () => ["auto", "primary", "fast"],
  getComputerCapabilities: () => runtimeSettings.computerCapabilities,
  getComputerConfirmationMode: () => runtimeSettings.computerConfirmationMode,
  getSnapshot: () => daemon.snapshot(),
  getTaskFacts: (taskId) => daemon.taskFacts(taskId),
  getTaskArtifact: (taskId, artifactId) => daemon.getTaskArtifact(taskId, artifactId),
  executeCommand: (command) => daemon.executeCommand(command),
  captureEditorContext: (kinds) => daemon.captureEditorContext(kinds),
  askCoder: async (taskId, question) => (runner ? runner.askCoder(taskId, question) : false),
  steerCoder: async (taskId, clarification) => (runner ? runner.steer(taskId, clarification) : false),
  followUpCoder: async (taskId, addition) => (runner ? runner.followUp(taskId, addition) : false),
  rememberFact: (scope, projectId, fact) => daemon.rememberFact(scope, projectId, fact),
  forgetFact: (memoryId) => daemon.forgetFact(memoryId),
  initialBriefs: briefStore.pending(),
  onBriefQueued: (brief) => briefStore.save(brief),
  onBriefDelivered: (taskIds) => briefStore.markDelivered(taskIds),
  controlComputer: (request) => computerController.control(request),
  emit: (type, payload) => daemon.emit(type, payload),
  emitAudio: (pcm) => daemon.emitAudio(pcm),
  initiallyEngaged: false,
});

observerBackend = new OmpObserverBackend(
  process.env["MAMACHI_OBSERVER_MODEL"] ?? initialRuntimeSettings.fastModel,
  authStorage,
);
observer = new PassiveObserver({
  backend: observerBackend,
  persist: (input) => daemon.recordObserverInterpretation(input),
  emit: (type, payload) => daemon.emit(type, payload),
});

runner = new OmpRunner({
  authStorage,
  getTask: (taskId) => daemon.snapshot().tasks.find((task) => task.id === taskId),
  getArtifacts: (ids) => daemon.getArtifacts(ids),
  emit: (type, payload) => {
    realtime?.noteHarnessEvent(type, payload);
    daemon.emit(type, payload);
  },
  onSafePause: (taskId, reason) => daemon.pauseAtSafeBoundary(taskId, reason),
  onAuthorizeTool: (taskId, toolName, input) => daemon.authorizeToolCall(taskId, toolName, input),
  onWorkspaceConflict: (taskId, conflict) => daemon.reportWorkspaceConflict(taskId, conflict),
  onRecordEvidence: (input) => daemon.recordToolEvidence(input),
  onComplete: (taskId, summary, evidenceIds) => daemon.completeTask(taskId, summary, evidenceIds),
  onFail: (taskId, error) => daemon.failTask(taskId, error),
  onNeedInput: (taskId, question) => daemon.awaitUserInput(taskId, question),
  onSessionBound: (taskId, runId, sessionId, sessionFile) =>
    daemon.recordCoderSession(taskId, runId, sessionId, sessionFile),
  runtimeSettings: initialRuntimeSettings,
});
await daemon.recoverAfterRestart();
if (connectionPath) {
  mkdirSync(dirname(connectionPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(connectionPath), 0o700);
  const temporaryPath = `${connectionPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: daemon.port,
      token,
      workspace: daemon.workspace,
    }),
    { mode: 0o600 },
  );
  renameSync(temporaryPath, connectionPath);
}


console.log(
  JSON.stringify({
    type: "mamachi.ready",
    port: daemon.port,
    token,
    workspace: daemon.workspace,
    databasePath,
  }),
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await realtime?.disconnect();
  await runner?.dispose();
  await observer?.dispose();
  daemon.close();
  briefStore.close();
  authStorage.close();
  if (connectionPath) {
    try {
      const descriptor = JSON.parse(readFileSync(connectionPath, "utf8")) as { token?: unknown };
      if (descriptor.token === token) rmSync(connectionPath);
    } catch {
      // A missing or replaced descriptor does not prevent daemon shutdown.
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
