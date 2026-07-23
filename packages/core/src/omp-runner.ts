import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type ExtensionFactory,
  type CreateAgentSessionResult,
  type CreateAgentSessionOptions,
} from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import type { TaskRecord } from "./domain.ts";
import type {
  CapturedContext,
  EvidenceArtifact,
  ToolEvidenceInput,
} from "./artifact-store.ts";
import {
  defaultRuntimeSettings,
  resolveTaskRoute,
  type RuntimeSettings,
} from "./model-router.ts";
import {
  WorkspaceGuard,
  type EditorDocumentState,
  type WorkspaceConflict,
} from "./workspace-guard.ts";

function configuredThinkingLevel(
  level: RuntimeSettings["thinkingLevel"],
): NonNullable<CreateAgentSessionOptions["thinkingLevel"]> {
  switch (level) {
    case "inherit": return ThinkingLevel.Inherit;
    case "auto": return "auto";
    case "off": return ThinkingLevel.Off;
    case "minimal": return ThinkingLevel.Minimal;
    case "low": return ThinkingLevel.Low;
    case "medium": return ThinkingLevel.Medium;
    case "high": return ThinkingLevel.High;
    case "xhigh": return ThinkingLevel.XHigh;
    case "max": return ThinkingLevel.Max;
  }
}


type SessionFactory = (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;

export interface OmpRunnerOptions {
  getTask: (taskId: string) => TaskRecord | undefined;
  getArtifacts?: (ids: readonly string[]) => CapturedContext[];
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
    backend: "omp",
    sessionId: string,
    sessionFile: string,
  ) => Promise<ActionResult>;
  authStorage?: NonNullable<CreateAgentSessionOptions["authStorage"]>;
  createSession?: SessionFactory;
  openSession?: (sessionFile: string) => Promise<SessionManager>;
  workspaceGuard?: WorkspaceGuard;
  runtimeSettings?: RuntimeSettings;
}

export class OmpRunner {
  readonly #options: OmpRunnerOptions;
  #session: AgentSession | null = null;
  #unsubscribe: (() => void) | null = null;
  #taskId: string | null = null;
  #generation = 0;
  #pauseRequested = false;
  #pauseAcknowledged = false;
  #runtimeSettings: RuntimeSettings;
  readonly #toolInputs = new Map<string, unknown>();
  readonly #evidenceIds: string[] = [];
  readonly #pendingEvidence = new Set<Promise<void>>();
  readonly #evidenceErrors: string[] = [];
  readonly #pendingQuestionAnswers = new Map<string, string>();
  #structuredSummary: string | null = null;
  readonly #workspaceGuard: WorkspaceGuard;

  constructor(options: OmpRunnerOptions) {
    this.#options = options;
    this.#runtimeSettings = options.runtimeSettings ?? defaultRuntimeSettings;
    this.#workspaceGuard = options.workspaceGuard ?? new WorkspaceGuard();
  }

  configure(settings: RuntimeSettings): void {
    this.#runtimeSettings = settings;
  }

  updateEditorState(state: EditorDocumentState): void {
    this.#workspaceGuard.updateEditorState(state);
  }

  async askCoder(taskId: string, question: string): Promise<boolean> {
    const session = this.#session;
    if (!session || taskId !== this.#taskId) return false;
    await session.followUp(
      `Answer this read-only user question from the current repository context without changing the accepted task specification: ${question}`,
    );
    return true;
  }

  async steer(taskId: string, clarification: string): Promise<boolean> {
    const session = this.#session;
    if (!session || taskId !== this.#taskId || !session.isStreaming) return false;
    await session.steer(`Safe clarification for the current specification: ${clarification}`);
    return true;
  }

  async followUp(taskId: string, addition: string): Promise<boolean> {
    const session = this.#session;
    if (!session || taskId !== this.#taskId) return false;
    await session.followUp(`Non-urgent addition within the current specification: ${addition}`);
    return true;
  }

  handleEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      const taskId = event.taskId;
      if (!taskId) continue;

      switch (event.type) {
        case "task.started":
          void this.#startTask(taskId, false);
          break;
        case "task.pauseRequested":
          if (taskId === this.#taskId) {
            this.#pauseRequested = true;
            this.#pauseAcknowledged = false;
            this.#options.emit("coder.pause_requested", { taskId, reason: event.payload.reason });
            if (this.#session && !this.#session.isStreaming) {
              void this.#acknowledgePause("coding agent reached an idle boundary");
            }
          }
          break;
        case "task.questionAnswered":
          this.#pendingQuestionAnswers.set(taskId, event.payload.answer);
          break;
        case "task.resumed": {
          const answer = this.#pendingQuestionAnswers.get(taskId);
          this.#pendingQuestionAnswers.delete(taskId);
          void this.#resumeTask(taskId, answer);
          break;
        }
        case "task.cancelled":
          if (taskId === this.#taskId) void this.#stopCurrent("task cancelled");
          break;
        default:
          break;
      }
    }
  }

  async dispose(): Promise<void> {
    this.#generation += 1;
    await this.#disposeSession();
    this.#workspaceGuard.finish();
    this.#taskId = null;
  }

  async #startTask(taskId: string, resumed: boolean, answer?: string): Promise<void> {
    const generation = ++this.#generation;
    await this.#disposeSession();
    const task = this.#options.getTask(taskId);
    if (!task || (task.state !== "running" && task.state !== "pause_requested")) return;

    this.#taskId = taskId;
    this.#pauseRequested = task.state === "pause_requested";
    this.#pauseAcknowledged = false;
    this.#structuredSummary = null;
    this.#toolInputs.clear();
    this.#evidenceIds.length = 0;
    this.#pendingEvidence.clear();
    this.#evidenceErrors.length = 0;
    const route = resolveTaskRoute(task, this.#runtimeSettings);
    this.#options.emit("coder.routed", {
      taskId,
      tier: route.tier,
      model: route.modelPattern ?? null,
      thinkingLevel: route.thinkingLevel,
      reason: route.reason,
    });
    this.#options.emit("coder.initializing", { taskId, repository: task.repositoryId });

    const executionGuardExtension: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "ask_coder",
        label: "Ask coder",
        description:
          "Pause at this safe boundary and ask the user one precise blocking question. Use only when a missing decision makes further work unsafe.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { question: { type: "string", minLength: 1 } },
          required: ["question"],
        },
        approval: "read",
        execute: async (_toolCallId, params) => {
          if (
            !params ||
            typeof params !== "object" ||
            !("question" in params) ||
            typeof params.question !== "string"
          ) {
            return {
              content: [{ type: "text" as const, text: "A string question is required." }],
              details: { accepted: false },
              isError: true,
            };
          }
          const question = params.question.trim();
          if (!question) {
            return {
              content: [{ type: "text" as const, text: "A non-empty question is required." }],
              details: { accepted: false },
            };
          }
          const result = await this.#options.onNeedInput(taskId, question);
          if (result.status !== "accepted") {
            const explanation =
              result.status === "rejected" ? result.explanation : "The question could not be persisted";
            return {
              content: [{ type: "text" as const, text: explanation }],
              details: { accepted: false },
              isError: true,
            };
          }
          this.#options.emit("coder.needs_attention", { taskId, question });
          return {
            content: [
              {
                type: "text" as const,
                text: "The question is persisted. Stop this turn and wait for the exact bound answer.",
              },
            ],
            details: { accepted: true },
          };
        },
      });
      pi.registerTool({
        name: "finish_coder",
        label: "Finish coder task",
        description:
          "Submit the final evidence-based task summary after implementation and verification are complete.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { summary: { type: "string", minLength: 1 } },
          required: ["summary"],
        },
        approval: "read",
        execute: async (_toolCallId, params) => {
          if (
            !params ||
            typeof params !== "object" ||
            !("summary" in params) ||
            typeof params.summary !== "string"
          ) {
            return {
              content: [{ type: "text" as const, text: "A string summary is required." }],
              details: { accepted: false },
              isError: true,
            };
          }
          this.#structuredSummary = params.summary.trim();
          return {
            content: [{ type: "text" as const, text: "Final summary captured by Mamachi." }],
            details: { accepted: true },
          };
        },
      });
      pi.on("tool_call", async (event, context) => {
        if (this.#pauseRequested && !this.#pauseAcknowledged && taskId === this.#taskId) {
          context.abort();
          await this.#acknowledgePause("coding agent stopped before the next tool execution");
          return {
            block: true,
            reason: "Mamachi paused this task before the tool could execute",
          };
        }

        if (event.toolName === "ask_coder" || event.toolName === "finish_coder") return;
        const authorization = await this.#options.onAuthorizeTool(taskId, event.toolName, event.input);
        if (authorization.status === "accepted") {
          const guard = await this.#workspaceGuard.beforeTool(
            event.toolCallId,
            event.toolName,
            event.input,
          );
          if (guard.status === "allowed") return;
          context.abort();
          await this.#reportWorkspaceConflict(taskId, guard.conflict);
          return { block: true, reason: guard.conflict.reason };
        }
        if (authorization.status === "confirmation_required") {
          context.abort();
          this.#options.emit("coder.needs_attention", {
            taskId,
            confirmationId: authorization.confirmationId,
            question: authorization.summary,
          });
          return { block: true, reason: `Mamachi requires user approval: ${authorization.summary}` };
        }
        const explanation =
          authorization.status === "rejected"
            ? authorization.explanation
            : "The requested tool action conflicted with current task state";
        this.#options.emit("coder.policy_blocked", { taskId, toolName: event.toolName, explanation });
        return { block: true, reason: explanation };
      });
    };

    try {
      if (!task.activeRunId) throw new Error("Running task has no active run for workspace attribution");
      await this.#workspaceGuard.start(task.id, task.activeRunId, task.repositoryId);
      const restoredSession =
        resumed && task.codingSession?.backend === "omp" && task.codingSession.file
          ? await (this.#options.openSession ?? ((sessionFile) => SessionManager.open(sessionFile)))(
              task.codingSession.file,
            )
          : undefined;
      if (task.codingSession?.backend === "omp" && task.codingSession.recoveryBoundary) {
        this.#options.emit("coder.recovery_boundary", {
          taskId,
          sessionId: task.codingSession.id,
          previousRunId: task.codingSession.recoveryBoundary.runId,
          reason: task.codingSession.recoveryBoundary.reason,
          unknownToolCall: task.codingSession.recoveryBoundary.unknownToolCall,
          replayedToolCall: false,
        });
      }
      const created = await (this.#options.createSession ?? createAgentSession)({
        cwd: task.repositoryId,
        ...(restoredSession ? { sessionManager: restoredSession } : {}),
        ...(this.#options.authStorage ? { authStorage: this.#options.authStorage } : {}),
        ...(route.modelPattern ? { modelPattern: route.modelPattern } : {}),
        thinkingLevel: configuredThinkingLevel(route.thinkingLevel),
        extensions: [executionGuardExtension],
        autoApprove: true,
        hasUI: false,
        enableMCP: false,
        enableIrc: false,
        skipPythonPreflight: true,
        appendSystemPrompt: [
          "You are the coding and research executor in Mamachi, a voice-orchestrated harness.",
          "Work autonomously inside the selected repository until the task is complete.",
          "Preserve pre-existing user changes. Do not commit, switch branches, or publish externally.",
          "Use repository tools, including web_search for current information, and verify the result.",
          "If one missing user decision makes further work unsafe, call ask_coder with one concise question, then stop.",
          "When the task is complete and verified, call finish_coder with the final evidence-based summary.",
          "If a model cannot call ask_coder, it may safely fall back to `MAMACHI_NEEDS_INPUT: <one concise question>`.",
        ].join("\n"),
      });
      if (generation !== this.#generation) {
        await created.session.dispose();
        return;
      }

      await created.session.sessionManager.ensureOnDisk();
      const sessionFile = created.session.sessionFile;
      if (!sessionFile) throw new Error("OMP session persistence did not produce a session file");
      if (
        restoredSession &&
        task.codingSession?.backend === "omp" &&
        created.session.sessionId !== task.codingSession.id
      ) {
        throw new Error(
          `Recovered OMP session identity mismatch: expected ${task.codingSession.id}, received ${created.session.sessionId}`,
        );
      }
      if (this.#options.onSessionBound) {
        const binding = await this.#options.onSessionBound(
          taskId,
          task.activeRunId,
          "omp",
          created.session.sessionId,
          sessionFile,
        );
        if (binding.status !== "accepted") {
          throw new Error(
            binding.status === "rejected"
              ? `Could not persist OMP session binding: ${binding.explanation}`
              : "OMP session binding unexpectedly requires confirmation",
          );
        }
      }
      this.#options.emit("coder.session_bound", {
        taskId,
        runId: task.activeRunId,
        backend: "omp",
        sessionId: created.session.sessionId,
        sessionFile,
        recovered: Boolean(restoredSession),
      });

      this.#session = created.session;
      this.#unsubscribe = created.session.subscribe((event) => {
        if (taskId !== this.#taskId || created.session !== this.#session) return;
        if (event.type === "tool_execution_start") {
          this.#options.emit("coder.tool_started", {
            taskId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            intent: event.intent ?? null,
          });
          this.#toolInputs.set(event.toolCallId, event.args);
        } else if (event.type === "tool_execution_end") {
          this.#options.emit("coder.tool_finished", {
            taskId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError ?? false,
          });
          const currentTask = this.#options.getTask(taskId);
          const input = this.#toolInputs.get(event.toolCallId) ?? {};
          this.#toolInputs.delete(event.toolCallId);
          const evidencePromise = this.#workspaceGuard
            .afterTool(event.toolCallId)
            .then(async (conflict) => {
              if (conflict) await this.#reportWorkspaceConflict(taskId, conflict);
              if (!currentTask?.activeRunId) return;
              const mutation = this.#workspaceGuard
                .mutations()
                .find((candidate) => candidate.toolCallId === event.toolCallId);
              const artifact = await this.#options.onRecordEvidence({
                taskId,
                runId: currentTask.activeRunId,
                repository: currentTask.repositoryId,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input,
                result: event.result,
                isError: event.isError ?? false,
                changedFiles: mutation?.paths ?? [],
              });
              if (taskId !== this.#taskId || created.session !== this.#session) return;
              this.#evidenceIds.push(artifact.id);
              this.#options.emit("coder.evidence_recorded", {
                taskId,
                artifactId: artifact.id,
                kind: artifact.kind,
                summary: artifact.summary,
                successful: artifact.successful,
              });
            })
            .catch(async (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              this.#evidenceErrors.push(message);
              this.#options.emit("coder.evidence_error", { taskId, error: message });
              await this.#options.onFail(
                taskId,
                `Workspace attribution or evidence capture failed closed: ${message}`,
              );
            });
          this.#pendingEvidence.add(evidencePromise);
          void evidencePromise.finally(() => this.#pendingEvidence.delete(evidencePromise));
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          const text = event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
            .trim();
          if (text) this.#options.emit("coder.message", { taskId, text });
        } else if (event.type === "agent_end" && this.#pauseRequested && !this.#pauseAcknowledged) {
          void this.#acknowledgePause("coding agent reached a turn boundary");
        }
      });

      this.#options.emit("coder.ready", {
        taskId,
        model: created.session.model
          ? `${created.session.model.provider}/${created.session.model.id}`
          : null,
      });
      await this.#runTask(
        task,
        resumed,
        generation,
        0,
        answer
          ? [
              ...(restoredSession ? [] : [this.#taskPrompt(task, true), ""]),
              `The exact answer to your pending question is: ${answer}`,
              "Continue the same task. Do not reinterpret this as a broader specification amendment.",
            ].join("\n")
          : undefined,
        answer && restoredSession ? "followUp" : "prompt",
      );
    } catch (error) {
      if (generation !== this.#generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#options.emit("coder.error", { taskId, error: message });
      await this.#options.onFail(taskId, message);
      await this.#disposeSession();
      this.#workspaceGuard.finish();
      this.#taskId = null;
    }
  }

  async #resumeTask(taskId: string, answer?: string): Promise<void> {
    const task = this.#options.getTask(taskId);
    if (!task || task.state !== "running") return;
    if (taskId !== this.#taskId || !this.#session) {
      await this.#startTask(taskId, true, answer);
      return;
    }

    const generation = ++this.#generation;
    this.#pauseRequested = false;
    this.#pauseAcknowledged = false;
    await this.#session.agent.waitForIdle();
    await Promise.all([...this.#pendingEvidence]);
    const sessionFile = this.#session.sessionFile;
    if (!sessionFile || !task.activeRunId) {
      await this.#options.onFail(taskId, "Cannot resume without a persistent OMP session binding");
      await this.#disposeSession();
      this.#workspaceGuard.finish();
      this.#taskId = null;
      return;
    }
    if (this.#options.onSessionBound) {
      const binding = await this.#options.onSessionBound(
        taskId,
        task.activeRunId,
        "omp",
        this.#session.sessionId,
        sessionFile,
      );
      if (binding.status !== "accepted") {
        const explanation =
          binding.status === "rejected"
            ? binding.explanation
            : "OMP session binding unexpectedly requires confirmation";
        await this.#options.onFail(taskId, `Could not persist OMP session binding: ${explanation}`);
        await this.#disposeSession();
        this.#workspaceGuard.finish();
        this.#taskId = null;
        return;
      }
    }
    this.#options.emit("coder.session_bound", {
      taskId,
      runId: task.activeRunId,
      backend: "omp",
      sessionId: this.#session.sessionId,
      sessionFile,
      recovered: false,
      reused: true,
    });
    const reconciled = await this.#workspaceGuard.reconcile();
    if (reconciled.length > 0) {
      this.#options.emit("coder.workspace_reconciled", { taskId, paths: reconciled });
    }
    this.#toolInputs.clear();
    this.#evidenceIds.length = 0;
    this.#pendingEvidence.clear();
    this.#evidenceErrors.length = 0;
    this.#structuredSummary = null;
    if (generation !== this.#generation) return;
    await this.#runTask(
      task,
      true,
      generation,
      0,
      answer
        ? `The exact answer to your pending question is: ${answer}\nContinue the same task and session. Do not reinterpret this as a broader specification amendment.`
        : undefined,
      answer ? "followUp" : "prompt",
    );
  }

  async #runTask(
    task: TaskRecord,
    resumed: boolean,
    generation: number,
    completionAttempt = 0,
    promptOverride?: string,
    delivery: "prompt" | "followUp" = "prompt",
  ): Promise<void> {
    const session = this.#session;
    if (!session || task.id !== this.#taskId) return;
    const prompt = promptOverride ?? this.#taskPrompt(task, resumed);
    this.#options.emit("coder.running", {
      taskId: task.id,
      revision: task.revision,
      resumed,
    });

    if (delivery === "followUp") {
      await session.followUp(prompt, undefined, { expandPromptTemplates: false });
      await Promise.resolve();
      await session.agent.waitForIdle();
    } else {
      await session.prompt(prompt, { expandPromptTemplates: false });
      await session.agent.waitForIdle();
    }
    if (generation !== this.#generation || task.id !== this.#taskId) return;

    await Promise.all([...this.#pendingEvidence]);
    if (generation !== this.#generation || task.id !== this.#taskId) return;
    const controllerTask = this.#options.getTask(task.id);
    if (controllerTask?.state === "awaiting_user") return;
    const lastMessage = session.getLastAssistantMessage();
    if (this.#pauseRequested || lastMessage?.stopReason === "aborted") {
      await this.#acknowledgePause("coding agent stopped at the end of its active turn");
      return;
    }
    const current = this.#options.getTask(task.id);
    if (!current || current.state !== "running") return;
    if (lastMessage?.stopReason === "error") {
      const error = session.getLastAssistantText()?.trim() || "OMP ended with a provider error";
      await this.#options.onFail(task.id, error);
    } else {
      const summary = this.#structuredSummary ?? session.getLastAssistantText()?.trim();
      if (!summary) {
        await this.#options.onFail(task.id, "OMP ended without a final task summary");
      } else if (summary.startsWith("MAMACHI_NEEDS_INPUT:")) {
        const question = summary.slice("MAMACHI_NEEDS_INPUT:".length).trim();
        if (!question) {
          await this.#options.onFail(task.id, "OMP requested input without a question");
        } else {
          const result = await this.#options.onNeedInput(task.id, question);
          if (result.status === "accepted") {
            this.#options.emit("coder.needs_attention", { taskId: task.id, question });
            return;
          }
          await this.#options.onFail(
            task.id,
            result.status === "rejected" ? result.explanation : "Could not pause for user input",
          );
        }
      } else {
        const completion = await this.#options.onComplete(task.id, summary, [...this.#evidenceIds]);
        if (completion.status === "rejected" && completion.code === "verification_incomplete") {
          if (completionAttempt >= 2) {
            await this.#options.onFail(
              task.id,
              `Completion remained unverified after corrective attempts: ${completion.explanation}`,
            );
          } else {
            this.#options.emit("coder.verification_required", {
              taskId: task.id,
              explanation: completion.explanation,
              evidenceErrors: [...this.#evidenceErrors],
            });
            const latest = this.#options.getTask(task.id);
            if (latest?.state === "running") {
              await this.#runTask(
                latest,
                false,
                generation,
                completionAttempt + 1,
                [
                  "The controller did not accept completion because verification evidence is incomplete.",
                  completion.explanation,
                  "Inspect the current working tree, run the smallest authoritative verification that covers the work, fix any failure, then report the final result.",
                ].join("\n"),
              );
              return;
            }
          }
        } else if (completion.status !== "accepted") {
          await this.#options.onFail(
            task.id,
            completion.status === "rejected" ? completion.explanation : "Completion unexpectedly requires confirmation",
          );
        }
      }
    }

    if (generation === this.#generation && task.id === this.#taskId) {
      await this.#disposeSession();
      this.#workspaceGuard.finish();
      this.#taskId = null;
    }
  }

  async #reportWorkspaceConflict(taskId: string, conflict: WorkspaceConflict): Promise<void> {
    this.#pauseRequested = true;
    this.#pauseAcknowledged = true;
    const current = this.#options.getTask(taskId);
    if (current?.state === "running") {
      const result = await this.#options.onWorkspaceConflict(taskId, conflict);
      if (result.status !== "accepted") {
        this.#options.emit("coder.error", {
          taskId,
          error: result.status === "rejected" ? result.explanation : "Workspace conflict requires confirmation",
        });
        return;
      }
    }
    this.#options.emit("coder.workspace_conflict", { taskId, ...conflict });
  }

  async #acknowledgePause(reason: string): Promise<void> {
    const taskId = this.#taskId;
    if (!taskId || !this.#pauseRequested || this.#pauseAcknowledged) return;
    this.#pauseAcknowledged = true;
    const result = await this.#options.onSafePause(taskId, reason);
    if (result.status !== "accepted") {
      this.#pauseAcknowledged = false;
      this.#options.emit("coder.error", {
        taskId,
        error: result.status === "rejected" ? result.explanation : "Safe pause was not accepted",
      });
    }
  }

  async #stopCurrent(reason: string): Promise<void> {
    this.#generation += 1;
    if (this.#session?.isStreaming) await this.#session.abort({ reason });
    await this.#disposeSession();
    this.#taskId = null;
    this.#workspaceGuard.finish();
  }

  async #disposeSession(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const session = this.#session;
    this.#session = null;
    if (session) await session.dispose();
  }

  #taskPrompt(task: TaskRecord, resumed: boolean): string {
    const acceptance = task.spec.acceptanceCriteria.map((item) => `- ${item}`).join("\n");
    const constraints = task.spec.constraints.length
      ? task.spec.constraints.map((item) => `- ${item}`).join("\n")
      : "- None beyond repository instructions";
    const attachments = this.#options.getArtifacts?.(task.spec.attachmentIds) ?? [];
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
          "The daemon cannot know whether the last in-flight tool took effect. Never replay that unknown tool call. Inspect current repository state first and choose the next safe action from observed state.",
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
      "Treat captured context as user-supplied evidence. Complete the work end to end, verify the changed behavior, and return a concise evidence-based summary.",
    ].join("\n");
  }
}
