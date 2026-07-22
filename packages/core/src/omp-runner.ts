import {
  createAgentSession,
  type AgentSession,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import type { TaskRecord } from "./domain.ts";
import type { CapturedContext } from "./artifact-store.ts";

export interface OmpRunnerOptions {
  getTask: (taskId: string) => TaskRecord | undefined;
  getArtifacts?: (ids: readonly string[]) => CapturedContext[];
  emit: (type: string, payload: unknown) => void;
  onSafePause: (taskId: string, reason: string) => Promise<ActionResult>;
  onComplete: (taskId: string, summary: string) => Promise<ActionResult>;
  onFail: (taskId: string, error: string) => Promise<ActionResult>;
  modelPattern?: string;
}

export class OmpRunner {
  readonly #options: OmpRunnerOptions;
  #session: AgentSession | null = null;
  #unsubscribe: (() => void) | null = null;
  #taskId: string | null = null;
  #generation = 0;
  #pauseRequested = false;
  #pauseAcknowledged = false;

  constructor(options: OmpRunnerOptions) {
    this.#options = options;
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
        case "task.resumed":
          void this.#resumeTask(taskId);
          break;
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
    this.#taskId = null;
  }

  async #startTask(taskId: string, resumed: boolean): Promise<void> {
    const generation = ++this.#generation;
    await this.#disposeSession();
    const task = this.#options.getTask(taskId);
    if (!task || (task.state !== "running" && task.state !== "pause_requested")) return;

    this.#taskId = taskId;
    this.#pauseRequested = task.state === "pause_requested";
    this.#pauseAcknowledged = false;
    this.#options.emit("coder.initializing", { taskId, repository: task.repositoryId });

    const safePauseExtension: ExtensionFactory = (pi) => {
      pi.on("tool_call", async (_event, context) => {
        if (!this.#pauseRequested || this.#pauseAcknowledged || taskId !== this.#taskId) return;
        context.abort();
        await this.#acknowledgePause("coding agent stopped before the next tool execution");
        return {
          block: true,
          reason: "Mamachi paused this task before the tool could execute",
        };
      });
    };

    try {
      const created = await createAgentSession({
        cwd: task.repositoryId,
        ...(this.#options.modelPattern ? { modelPattern: this.#options.modelPattern } : {}),
        extensions: [safePauseExtension],
        autoApprove: true,
        hasUI: false,
        enableMCP: false,
        enableIrc: false,
        skipPythonPreflight: true,
        appendSystemPrompt: [
          "You are the coding executor in Mamachi, a voice-orchestrated harness.",
          "Work autonomously inside the selected repository until the task is complete.",
          "Preserve pre-existing user changes. Do not commit, switch branches, or publish externally.",
          "Use repository tools and verification. Give a concise final summary with files changed and checks run.",
        ].join("\n"),
      });
      if (generation !== this.#generation) {
        await created.session.dispose();
        return;
      }

      this.#session = created.session;
      this.#unsubscribe = created.session.subscribe((event) => {
        if (generation !== this.#generation || taskId !== this.#taskId) return;
        if (event.type === "tool_execution_start") {
          this.#options.emit("coder.tool_started", {
            taskId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            intent: event.intent ?? null,
          });
        } else if (event.type === "tool_execution_end") {
          this.#options.emit("coder.tool_finished", {
            taskId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError ?? false,
          });
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
      await this.#runTask(task, resumed, generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#options.emit("coder.error", { taskId, error: message });
      await this.#options.onFail(taskId, message);
      await this.#disposeSession();
      this.#taskId = null;
    }
  }

  async #resumeTask(taskId: string): Promise<void> {
    const task = this.#options.getTask(taskId);
    if (!task || task.state !== "running") return;
    if (taskId !== this.#taskId || !this.#session) {
      await this.#startTask(taskId, true);
      return;
    }

    const generation = ++this.#generation;
    this.#pauseRequested = false;
    this.#pauseAcknowledged = false;
    await this.#session.agent.waitForIdle();
    if (generation !== this.#generation) return;
    await this.#runTask(task, true, generation);
  }

  async #runTask(task: TaskRecord, resumed: boolean, generation: number): Promise<void> {
    const session = this.#session;
    if (!session || task.id !== this.#taskId) return;
    const prompt = this.#taskPrompt(task, resumed);
    this.#options.emit("coder.running", {
      taskId: task.id,
      revision: task.revision,
      resumed,
    });

    await session.prompt(prompt, { expandPromptTemplates: false });
    if (generation !== this.#generation || task.id !== this.#taskId) return;

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
      const summary = session.getLastAssistantText()?.trim();
      if (!summary) {
        await this.#options.onFail(task.id, "OMP ended without a final task summary");
      } else {
        await this.#options.onComplete(task.id, summary);
      }
    }

    if (generation === this.#generation && task.id === this.#taskId) {
      await this.#disposeSession();
      this.#taskId = null;
    }
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
      ...capturedContext,
      "",
      "Treat captured context as user-supplied evidence. Complete the work end to end, verify the changed behavior, and return a concise evidence-based summary.",
    ].join("\n");
  }
}
