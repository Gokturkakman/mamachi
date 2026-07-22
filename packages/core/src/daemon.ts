import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MamachiIpcServer } from "./ipc-server.ts";
import { OmpRunner } from "./omp-runner.ts";
import { RealtimeBridge } from "./realtime-bridge.ts";

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

let runner: OmpRunner | null = null;
let realtime: RealtimeBridge | null = null;
const daemon = new MamachiIpcServer({
  token,
  port,
  databasePath,
  initialWorkspace: process.env["MAMACHI_WORKSPACE"] ?? process.cwd(),
  hooks: {
    onAudioInput: (pcm) => realtime?.appendAudio(pcm),
    onContextCaptured: (context) => realtime?.captureContext(context),
    onTaskEvents: async (events) => {
      realtime?.handleTaskEvents(events);
      await runner?.handleEvents(events);
    },
    onVoiceConnect: (apiKey) => realtime?.connect(apiKey),
    onVoiceDisconnect: () => realtime?.disconnect(),
    onVoiceInterrupt: () => realtime?.interrupt(),
    onVoiceText: (text) => realtime?.sendText(text),
  },
});

realtime = new RealtimeBridge({
  ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
  getWorkspace: () => daemon.workspace,
  getSnapshot: () => daemon.snapshot(),
  executeCommand: (command) => daemon.executeCommand(command),
  emit: (type, payload) => daemon.emit(type, payload),
  emitAudio: (pcm) => daemon.emitAudio(pcm),
});

runner = new OmpRunner({
  getTask: (taskId) => daemon.snapshot().tasks.find((task) => task.id === taskId),
  getArtifacts: (ids) => daemon.getArtifacts(ids),
  emit: (type, payload) => {
    realtime?.noteHarnessEvent(type, payload);
    daemon.emit(type, payload);
  },
  onSafePause: (taskId, reason) => daemon.pauseAtSafeBoundary(taskId, reason),
  onComplete: (taskId, summary) => daemon.completeTask(taskId, summary),
  onFail: (taskId, error) => daemon.failTask(taskId, error),
  ...(process.env["MAMACHI_CODING_MODEL"]
    ? { modelPattern: process.env["MAMACHI_CODING_MODEL"] }
    : {}),
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
  daemon.close();
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
