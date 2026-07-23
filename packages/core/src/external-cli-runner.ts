import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import type { EvidenceArtifact, ToolEvidenceInput } from "./artifact-store.ts";
import type { TaskRecord } from "./domain.ts";
import {
  defaultRuntimeSettings,
  resolveTaskRoute,
  type CodingBackend,
  type RuntimeSettings,
} from "./model-router.ts";
import {
  WorkspaceGuard,
  type EditorDocumentState,
  type WorkspaceConflict,
} from "./workspace-guard.ts";

export type ExternalCodingBackend = Exclude<CodingBackend, "omp">;

export interface CliCapturedArtifact {
  id: string;
  kind: string;
  summary: string;
  payload: unknown;
}

export interface ExternalCliRunnerOptions {
  backend: ExternalCodingBackend;
  getTask: (taskId: string) => TaskRecord | undefined;
  getArtifacts?: (ids: readonly string[]) => CliCapturedArtifact[];
  emit: (type: string, payload: unknown) => void;
  onSafePause: (taskId: string, reason: string) => Promise<ActionResult>;
  onAuthorizeTool: (taskId: string, toolName: string, input: unknown) => Promise<ActionResult>;
  onWorkspaceConflict: (taskId: string, conflict: WorkspaceConflict) => Promise<ActionResult>;
  onRecordEvidence: (input: ToolEvidenceInput) => Promise<EvidenceArtifact>;
  onComplete: (taskId: string, summary: string, evidenceIds: string[]) => Promise<ActionResult>;
  onFail: (taskId: string, error: string) => Promise<ActionResult>;
  onNeedInput: (taskId: string, question: string) => Promise<ActionResult>;
  onSessionBound?: (
    taskId: string,
    runId: string,
    backend: ExternalCodingBackend,
    sessionId: string,
    sessionFile: null,
  ) => Promise<ActionResult>;
  environment?: Record<string, string | undefined>;
  executable?: string;
  workspaceGuard?: WorkspaceGuard;
  runtimeSettings?: RuntimeSettings;
}

interface CliProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly stdin: {
    write(data: string | Uint8Array): number | Promise<number>;
    end(error?: Error): number | Promise<number>;
  };
  kill(signal?: number | NodeJS.Signals): void;
}

interface ToolObservation {
  id: string;
  name: string;
  input: Record<string, unknown>;
  sequence: number;
}

interface VerificationObservation {
  sequence: number;
  command: string;
  result: unknown;
}

const verificationCommandPattern =
  /(?:^|\s)(?:test|tests|typecheck|check|build|lint|verify)(?:\s|$)|\b(?:pytest|swift\s+test|cargo\s+test|go\s+test|bun\s+test|npm\s+test|tsc\b)/i;
const mutatingCommandPattern =
  /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|rmdir|touch|truncate|tee|install|patch|git\s+(?:checkout|switch|reset|restore|clean|apply))\b|(?:^|[^>])>(?!>)/i;
const mutatingTools = new Set(["edit", "write", "notebook", "lsp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function executableCandidates(backend: ExternalCodingBackend): string[] {
  const home = homedir();
  const command = backend === "codex" ? "codex" : "claude";
  const candidates = [
    join(home, ".local", "bin", command),
    join(home, ".bun", "bin", command),
    join(home, ".npm-global", "bin", command),
    join(home, ".claude", "local", command),
    join("/opt/homebrew/bin", command),
    join("/usr/local/bin", command),
  ];
  const nvmRoot = join(home, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) candidates.push(join(nvmRoot, version, "bin", command));
  } catch {
    // NVM is optional.
  }
  return candidates;
}

export function resolveCodingAgentExecutable(
  backend: ExternalCodingBackend,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = environment[backend === "codex" ? "MAMACHI_CODEX_PATH" : "MAMACHI_CLAUDE_PATH"];
  if (explicit?.trim()) return existsSync(explicit.trim()) ? explicit.trim() : null;
  const command = backend === "codex" ? "codex" : "claude";
  const fromPath = Bun.which(command);
  if (fromPath) return fromPath;
  return executableCandidates(backend).find((candidate) => existsSync(candidate)) ?? null;
}

export function modelForExternalBackend(
  backend: ExternalCodingBackend,
  pattern: string | undefined,
): string | undefined {
  const value = pattern?.trim();
  if (!value) return undefined;
  if (!value.includes("/")) return value;
  const separator = value.indexOf("/");
  const provider = value.slice(0, separator).toLowerCase();
  const model = value.slice(separator + 1).trim();
  if (!model) return undefined;
  if (backend === "codex" && ["openai", "openai-codex", "codex"].includes(provider)) return model;
  if (backend === "claude" && ["anthropic", "claude", "claude-code"].includes(provider)) return model;
  return undefined;
}

async function* decodedLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline === -1) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield line;
      }
    }
    pending += decoder.decode();
    if (pending.trim()) yield pending.trim();
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedText(stream: ReadableStream<Uint8Array>, limit = 65_536): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (result.length >= limit) {
        truncated = true;
        continue;
      }
      const decoded = decoder.decode(value, { stream: true });
      const available = limit - result.length;
      result += decoded.slice(0, available);
      if (decoded.length > available) truncated = true;
    }
    result += decoder.decode().slice(0, Math.max(0, limit - result.length));
  } finally {
    reader.releaseLock();
  }
  const text = result.trim();
  return truncated ? `${text}\n[output truncated]`.trim() : text;
}

function normalizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const names: Record<string, string> = {
    bash: "bash",
    command_execution: "bash",
    edit: "edit",
    file_change: "edit",
    glob: "glob",
    grep: "grep",
    notebookedit: "notebook",
    read: "read",
    webfetch: "web_fetch",
    websearch: "web_search",
    write: "write",
  };
  return names[normalized] ?? normalized.replaceAll(/[^a-z0-9_]+/g, "_");
}

function commandFromInput(input: Record<string, unknown>): string {
  return nonEmptyString(input["command"]) ?? nonEmptyString(input["cmd"]) ?? "";
}

function taskPrompt(
  task: TaskRecord,
  resumed: boolean,
  attachments: readonly CliCapturedArtifact[],
): string {
  const acceptance = task.spec.acceptanceCriteria.map((item) => `- ${item}`).join("\n");
  const constraints = task.spec.constraints.length
    ? task.spec.constraints.map((item) => `- ${item}`).join("\n")
    : "- None beyond repository instructions";
  const capturedContext = attachments.length
    ? [
        "",
        "Explicitly captured editor context:",
        ...attachments.map((attachment) =>
          [
            `--- ${attachment.kind}: ${attachment.summary} (${attachment.id}) ---`,
            JSON.stringify(attachment.payload, null, 2),
          ].join("\n"),
        ),
      ]
    : [];
  const recoveryBoundary = task.codingSession?.recoveryBoundary
    ? [
        "",
        "Recovery boundary:",
        task.codingSession.recoveryBoundary.reason,
        "The previous process may have stopped during a tool action. Do not replay an unknown action. Inspect current repository state first.",
      ]
    : [];
  return [
    resumed
      ? `Resume task ${task.id} under accepted specification revision ${task.revision}. Re-read affected files before editing.`
      : `Execute task ${task.id} under specification revision ${task.revision}.`,
    "",
    "Objective:",
    task.spec.objective,
    "",
    "Acceptance criteria:",
    acceptance,
    "",
    "Constraints:",
    constraints,
    ...recoveryBoundary,
    ...capturedContext,
    "",
    "Work autonomously inside this repository until the task is complete.",
    "Preserve pre-existing user changes. Do not commit, switch branches, publish, deploy, or access credentials.",
    "Use the agent's repository tools and verify the changed behavior with the smallest authoritative command.",
    "If one missing user decision makes further work unsafe, end with exactly `MAMACHI_NEEDS_INPUT: <one concise question>`.",
    "Otherwise end with a concise evidence-based summary. Do not claim completion before verification succeeds.",
  ].join("\n");
}

function spawnCli(argv: readonly string[], cwd: string, environment: Record<string, string>): CliProcess {
  return Bun.spawn([...argv], {
    cwd,
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export class ExternalCliRunner {
  readonly #options: ExternalCliRunnerOptions;
  readonly #backend: ExternalCodingBackend;
  readonly #workspaceGuard: WorkspaceGuard;
  #runtimeSettings: RuntimeSettings;
  #process: CliProcess | null = null;
  #taskId: string | null = null;
  #generation = 0;
  #pauseRequested = false;
  #policyPauseReason: string | null = null;
  #sessionId: string | null = null;
  #sequence = 0;
  #lastMutationSequence = 0;
  #latestVerification: VerificationObservation | null = null;
  #summary = "";
  #resultError: string | null = null;
  readonly #tools = new Map<string, ToolObservation>();
  readonly #evidenceIds: string[] = [];
  readonly #pendingQuestionAnswers = new Map<string, string>();

  constructor(options: ExternalCliRunnerOptions) {
    this.#options = options;
    this.#backend = options.backend;
    this.#workspaceGuard = options.workspaceGuard ?? new WorkspaceGuard();
    this.#runtimeSettings = options.runtimeSettings ?? defaultRuntimeSettings;
  }

  configure(settings: RuntimeSettings): void {
    this.#runtimeSettings = settings;
  }

  updateEditorState(state: EditorDocumentState): void {
    this.#workspaceGuard.updateEditorState(state);
  }

  async askCoder(): Promise<boolean> {
    return false;
  }

  async steer(): Promise<boolean> {
    return false;
  }

  async followUp(): Promise<boolean> {
    return false;
  }

  handleEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      const taskId = event.taskId;
      if (!taskId) continue;
      switch (event.type) {
        case "task.started":
          void this.#startTask(taskId, false);
          break;
        case "task.questionAnswered":
          this.#pendingQuestionAnswers.set(taskId, event.payload.answer);
          break;
        case "task.resumed": {
          const answer = this.#pendingQuestionAnswers.get(taskId);
          this.#pendingQuestionAnswers.delete(taskId);
          void this.#startTask(taskId, true, answer);
          break;
        }
        case "task.pauseRequested":
          if (taskId === this.#taskId) {
            this.#pauseRequested = true;
            this.#process?.kill("SIGTERM");
          }
          break;
        case "task.cancelled":
          if (taskId === this.#taskId) void this.#stopCurrent();
          break;
        default:
          break;
      }
    }
  }

  async dispose(): Promise<void> {
    this.#generation += 1;
    this.#process?.kill("SIGTERM");
    this.#process = null;
    this.#workspaceGuard.finish();
    this.#taskId = null;
  }

  async #startTask(taskId: string, resumed: boolean, answer?: string): Promise<void> {
    const generation = ++this.#generation;
    this.#process?.kill("SIGTERM");
    this.#process = null;
    const task = this.#options.getTask(taskId);
    if (!task || (task.state !== "running" && task.state !== "pause_requested")) return;
    if (!task.activeRunId) {
      await this.#options.onFail(taskId, "Running task has no active run for workspace attribution");
      return;
    }

    this.#taskId = taskId;
    this.#pauseRequested = task.state === "pause_requested";
    this.#policyPauseReason = null;
    this.#sessionId =
      resumed && task.codingSession?.backend === this.#backend ? task.codingSession.id : null;
    this.#evidenceIds.length = 0;
    await this.#workspaceGuard.start(task.id, task.activeRunId, task.repositoryId);
    if (this.#sessionId && this.#options.onSessionBound) {
      const binding = await this.#options.onSessionBound(
        task.id,
        task.activeRunId,
        this.#backend,
        this.#sessionId,
        null,
      );
      if (binding.status !== "accepted") {
        await this.#fail(task, "The existing coding session could not be bound to the resumed run");
        return;
      }
    }

    const prompt = answer
      ? [
          taskPrompt(task, resumed, this.#options.getArtifacts?.(task.spec.attachmentIds) ?? []),
          "",
          `The exact answer to your pending question is: ${answer}`,
          "Continue the same task. Do not reinterpret this as a broader specification amendment.",
        ].join("\n")
      : taskPrompt(task, resumed, this.#options.getArtifacts?.(task.spec.attachmentIds) ?? []);
    await this.#runTurn(task, generation, prompt, 0);
  }

  async #runTurn(
    task: TaskRecord,
    generation: number,
    prompt: string,
    completionAttempt: number,
  ): Promise<void> {
    if (generation !== this.#generation || task.id !== this.#taskId || !task.activeRunId) return;
    this.#resetTurnObservations();
    const turnId = `${this.#backend}-${Bun.randomUUIDv7()}`;
    const guard = await this.#workspaceGuard.beginExternalTurn(turnId, this.#backend);
    if (guard.status === "conflict") {
      await this.#options.onWorkspaceConflict(task.id, guard.conflict);
      this.#workspaceGuard.finish();
      this.#taskId = null;
      return;
    }

    const executable = this.#options.executable ?? resolveCodingAgentExecutable(this.#backend, this.#options.environment);
    if (!executable) {
      await this.#fail(
        task,
        `${this.#backend === "codex" ? "Codex" : "Claude Code"} is not installed. Open Mamachi Settings → Coding agent to install or select another backend.`,
      );
      return;
    }
    const route = resolveTaskRoute(task, this.#runtimeSettings);
    const model = modelForExternalBackend(this.#backend, route.modelPattern);
    const argv = this.#arguments(executable, model);
    const environment = this.#processEnvironment();
    this.#options.emit("coder.routed", {
      taskId: task.id,
      backend: this.#backend,
      tier: route.tier,
      model: model ?? null,
      thinkingLevel: route.thinkingLevel,
      reason: route.reason,
    });
    this.#options.emit("coder.initializing", {
      taskId: task.id,
      backend: this.#backend,
      repository: task.repositoryId,
    });

    const child = spawnCli(argv, task.repositoryId, environment);
    this.#process = child;
    child.stdin.write(prompt);
    await child.stdin.end();
    const stderrPromise = readBoundedText(child.stderr);
    this.#options.emit("coder.running", {
      taskId: task.id,
      backend: this.#backend,
      revision: task.revision,
      resumed: Boolean(this.#sessionId),
    });

    try {
      for await (const line of decodedLines(child.stdout)) {
        if (generation !== this.#generation || task.id !== this.#taskId) break;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          this.#summary = line;
          continue;
        }
        await this.#handleCliEvent(task, event);
        if (this.#policyPauseReason) child.kill("SIGTERM");
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
      if (this.#process === child) this.#process = null;
      if (generation !== this.#generation || task.id !== this.#taskId) return;

      const turn = await this.#workspaceGuard.endExternalTurn(turnId);
      if (turn.conflict) {
        await this.#options.onWorkspaceConflict(task.id, turn.conflict);
        this.#workspaceGuard.finish();
        this.#taskId = null;
        return;
      }
      if (this.#policyPauseReason) {
        await this.#options.onSafePause(task.id, this.#policyPauseReason);
        this.#workspaceGuard.finish();
        this.#taskId = null;
        return;
      }
      if (this.#pauseRequested) {
        await this.#options.onSafePause(task.id, "External coding agent stopped at the requested process boundary");
        this.#workspaceGuard.finish();
        this.#taskId = null;
        return;
      }

      const error = this.#resultError ?? (exitCode === 0 ? null : stderr || `${this.#backend} exited with code ${exitCode}`);
      await this.#recordTurnEvidence(task, turnId, turn.changedFiles, error);
      if (error) {
        await this.#fail(task, this.#actionableError(error));
        return;
      }

      const summary = this.#summary.trim();
      const question = this.#questionFromSummary(summary);
      if (question) {
        const result = await this.#options.onNeedInput(task.id, question);
        if (result.status === "accepted") {
          this.#options.emit("coder.needs_attention", { taskId: task.id, question });
          this.#workspaceGuard.finish();
          this.#taskId = null;
          return;
        }
        await this.#fail(
          task,
          result.status === "rejected" ? result.explanation : "Could not persist the coding agent question",
        );
        return;
      }
      if (!summary) {
        await this.#fail(task, `${this.#backend} ended without a final task summary`);
        return;
      }

      const completion = await this.#options.onComplete(task.id, summary, [...this.#evidenceIds]);
      if (completion.status === "rejected" && completion.code === "verification_incomplete" && completionAttempt < 2) {
        this.#options.emit("coder.verification_required", {
          taskId: task.id,
          backend: this.#backend,
          explanation: completion.explanation,
        });
        const latest = this.#options.getTask(task.id);
        if (latest?.state === "running") {
          await this.#workspaceGuard.reconcile();
          await this.#runTurn(
            latest,
            generation,
            [
              "The controller did not accept completion because verification evidence is incomplete.",
              completion.explanation,
              "Inspect the current working tree, run the smallest authoritative verification that covers the work, fix any failure, then report the final result.",
            ].join("\n"),
            completionAttempt + 1,
          );
          return;
        }
      } else if (completion.status !== "accepted") {
        await this.#fail(
          task,
          completion.status === "rejected"
            ? completion.explanation
            : "Completion unexpectedly requires confirmation",
        );
        return;
      }
      this.#workspaceGuard.finish();
      this.#taskId = null;
    } catch (error) {
      if (this.#process === child) this.#process = null;
      if (generation !== this.#generation || task.id !== this.#taskId) return;
      await this.#fail(task, error instanceof Error ? error.message : String(error));
    }
  }

  #arguments(executable: string, model: string | undefined): string[] {
    if (this.#backend === "codex") {
      if (this.#sessionId) {
        return [
          executable,
          "exec",
          "resume",
          "--json",
          "--skip-git-repo-check",
          ...(model ? ["--model", model] : []),
          this.#sessionId,
          "-",
        ];
      }
      return [
        executable,
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        ...(model ? ["--model", model] : []),
        "-",
      ];
    }
    return [
      executable,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--append-system-prompt",
      "Mamachi is supervising this coding run. Stay inside the selected repository, preserve user changes, avoid commits and external side effects, and verify before finishing.",
      ...(model ? ["--model", model] : []),
      ...(this.#sessionId ? ["--resume", this.#sessionId] : []),
    ];
  }

  #processEnvironment(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) result[key] = value;
    }
    for (const [key, value] of Object.entries(this.#options.environment ?? {})) {
      if (value !== undefined) result[key] = value;
    }
    result["NO_COLOR"] = "1";
    result["TERM"] = "dumb";
    return result;
  }

  async #handleCliEvent(task: TaskRecord, value: unknown): Promise<void> {
    if (!isRecord(value)) return;
    if (this.#backend === "codex") {
      await this.#handleCodexEvent(task, value);
    } else {
      await this.#handleClaudeEvent(task, value);
    }
  }

  async #handleCodexEvent(task: TaskRecord, event: Record<string, unknown>): Promise<void> {
    const type = nonEmptyString(event["type"]);
    if (type === "thread.started") {
      await this.#bindSession(task, nonEmptyString(event["thread_id"]));
      return;
    }
    if ((type === "item.started" || type === "item.completed") && isRecord(event["item"])) {
      const item = event["item"];
      const itemType = nonEmptyString(item["type"]);
      const id = nonEmptyString(item["id"]) ?? `codex-${++this.#sequence}`;
      if (itemType === "agent_message") {
        const text = nonEmptyString(item["text"]);
        if (text) {
          this.#summary = text;
          this.#options.emit("coder.message", { taskId: task.id, text });
        }
        return;
      }
      if (itemType === "reasoning") return;
      const name = normalizeToolName(itemType ?? "codex_tool");
      const input = itemType === "command_execution"
        ? { command: nonEmptyString(item["command"]) ?? "" }
        : { ...item };
      if (type === "item.started") {
        await this.#startTool(task, id, name, input);
      } else {
        if (!this.#tools.has(id)) await this.#startTool(task, id, name, input);
        const isError = item["status"] === "failed" || (typeof item["exit_code"] === "number" && item["exit_code"] !== 0);
        await this.#finishTool(task, id, {
          output: item["aggregated_output"] ?? item["output"] ?? null,
          exitCode: item["exit_code"] ?? null,
        }, isError);
      }
      return;
    }
    if (type === "turn.failed" || type === "error") {
      this.#resultError = nonEmptyString(event["message"])
        ?? (isRecord(event["error"]) ? nonEmptyString(event["error"]["message"]) : null)
        ?? "Codex reported a failed turn";
    }
  }

  async #handleClaudeEvent(task: TaskRecord, event: Record<string, unknown>): Promise<void> {
    const type = nonEmptyString(event["type"]);
    if (type === "system" && event["subtype"] === "init") {
      await this.#bindSession(task, nonEmptyString(event["session_id"]));
      this.#options.emit("coder.ready", {
        taskId: task.id,
        backend: this.#backend,
        model: event["model"] ?? null,
      });
      return;
    }
    if ((type === "assistant" || type === "user") && isRecord(event["message"])) {
      const content = event["message"]["content"];
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part["type"] === "text" && type === "assistant") {
          const text = nonEmptyString(part["text"]);
          if (text) {
            this.#summary = text;
            this.#options.emit("coder.message", { taskId: task.id, text });
          }
        } else if (part["type"] === "tool_use") {
          const id = nonEmptyString(part["id"]) ?? `claude-${++this.#sequence}`;
          const name = normalizeToolName(nonEmptyString(part["name"]) ?? "claude_tool");
          const input = isRecord(part["input"]) ? part["input"] : {};
          await this.#startTool(task, id, name, input);
        } else if (part["type"] === "tool_result") {
          const id = nonEmptyString(part["tool_use_id"]);
          if (id) await this.#finishTool(task, id, part["content"] ?? null, part["is_error"] === true);
        }
      }
      return;
    }
    if (type === "result") {
      await this.#bindSession(task, nonEmptyString(event["session_id"]));
      const result = nonEmptyString(event["result"]);
      if (result) this.#summary = result;
      if (event["is_error"] === true || event["subtype"] === "error") {
        this.#resultError = result ?? "Claude Code reported a failed turn";
      }
    }
  }

  async #bindSession(task: TaskRecord, sessionId: string | null): Promise<void> {
    if (!sessionId || sessionId === this.#sessionId) return;
    this.#sessionId = sessionId;
    if (!task.activeRunId || !this.#options.onSessionBound) return;
    const binding = await this.#options.onSessionBound(
      task.id,
      task.activeRunId,
      this.#backend,
      sessionId,
      null,
    );
    if (binding.status !== "accepted") {
      this.#resultError = "Mamachi could not persist the external coding session identity";
      this.#process?.kill("SIGTERM");
      return;
    }
    this.#options.emit("coder.session_bound", {
      taskId: task.id,
      runId: task.activeRunId,
      backend: this.#backend,
      sessionId,
      sessionFile: null,
      recovered: task.codingSession?.id === sessionId,
    });
  }

  async #startTool(
    task: TaskRecord,
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (this.#tools.has(id)) return;
    const observation = { id, name, input, sequence: ++this.#sequence };
    this.#tools.set(id, observation);
    const command = commandFromInput(input);
    if (mutatingTools.has(name) || (name === "bash" && mutatingCommandPattern.test(command))) {
      this.#lastMutationSequence = observation.sequence;
    }
    this.#options.emit("coder.tool_started", {
      taskId: task.id,
      toolCallId: id,
      toolName: name,
      intent: null,
      backend: this.#backend,
    });
    const authorization = await this.#options.onAuthorizeTool(task.id, name, input);
    if (authorization.status === "accepted") return;
    if (authorization.status === "confirmation_required") {
      this.#options.emit("coder.needs_attention", {
        taskId: task.id,
        confirmationId: authorization.confirmationId,
        question: authorization.summary,
      });
      this.#policyPauseReason = `Mamachi requires approval before ${name}: ${authorization.summary}`;
    } else {
      this.#policyPauseReason = `Mamachi blocked ${name}: ${authorization.explanation}`;
      this.#options.emit("coder.policy_blocked", {
        taskId: task.id,
        toolName: name,
        explanation: authorization.explanation,
      });
    }
  }

  async #finishTool(task: TaskRecord, id: string, result: unknown, isError: boolean): Promise<void> {
    const tool = this.#tools.get(id);
    if (!tool) return;
    this.#tools.delete(id);
    this.#options.emit("coder.tool_finished", {
      taskId: task.id,
      toolCallId: id,
      toolName: tool.name,
      isError,
      backend: this.#backend,
    });
    const command = commandFromInput(tool.input);
    if (!isError && tool.name === "bash" && verificationCommandPattern.test(command)) {
      this.#latestVerification = { sequence: tool.sequence, command, result };
    }
  }

  async #recordTurnEvidence(
    task: TaskRecord,
    turnId: string,
    changedFiles: string[],
    error: string | null,
  ): Promise<void> {
    if (!task.activeRunId) return;
    const artifact = await this.#options.onRecordEvidence({
      taskId: task.id,
      runId: task.activeRunId,
      repository: task.repositoryId,
      toolCallId: turnId,
      toolName: this.#backend,
      input: { backend: this.#backend, sessionId: this.#sessionId },
      result: error ?? this.#summary,
      isError: error !== null,
      changedFiles,
    });
    this.#evidenceIds.push(artifact.id);
    this.#options.emit("coder.evidence_recorded", {
      taskId: task.id,
      artifactId: artifact.id,
      kind: artifact.kind,
      summary: artifact.summary,
      successful: artifact.successful,
    });
    if (
      !error &&
      this.#latestVerification &&
      this.#latestVerification.sequence > this.#lastMutationSequence
    ) {
      const verification = await this.#options.onRecordEvidence({
        taskId: task.id,
        runId: task.activeRunId,
        repository: task.repositoryId,
        toolCallId: `${turnId}-verification`,
        toolName: "bash",
        input: { command: this.#latestVerification.command },
        result: this.#latestVerification.result,
        isError: false,
        changedFiles: [],
      });
      this.#evidenceIds.push(verification.id);
      this.#options.emit("coder.evidence_recorded", {
        taskId: task.id,
        artifactId: verification.id,
        kind: verification.kind,
        summary: verification.summary,
        successful: verification.successful,
      });
    }
  }

  #resetTurnObservations(): void {
    this.#sequence = 0;
    this.#lastMutationSequence = 0;
    this.#latestVerification = null;
    this.#summary = "";
    this.#resultError = null;
    this.#tools.clear();
    this.#policyPauseReason = null;
  }

  #questionFromSummary(summary: string): string | null {
    const marker = "MAMACHI_NEEDS_INPUT:";
    const index = summary.indexOf(marker);
    if (index === -1) return null;
    return summary.slice(index + marker.length).trim() || null;
  }

  #actionableError(error: string): string {
    const normalized = error.toLowerCase();
    if (
      normalized.includes("not logged in") ||
      normalized.includes("authentication") ||
      normalized.includes("unauthorized") ||
      normalized.includes("please login")
    ) {
      const name = this.#backend === "codex" ? "Codex" : "Claude Code";
      return `${name} is not logged in. Open Mamachi Settings → Coding agent and click Log In.`;
    }
    return error;
  }

  async #fail(task: TaskRecord, error: string): Promise<void> {
    await this.#options.onFail(task.id, error);
    this.#process?.kill("SIGTERM");
    this.#process = null;
    this.#workspaceGuard.finish();
    this.#taskId = null;
  }

  async #stopCurrent(): Promise<void> {
    this.#generation += 1;
    this.#process?.kill("SIGTERM");
    this.#process = null;
    this.#workspaceGuard.finish();
    this.#taskId = null;
  }
}
