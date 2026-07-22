import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
  ObserverInterpretation,
  ObserverInterpretationInput,
} from "./artifact-store.ts";
import type { TaskFacts } from "./fact-projector.ts";

export interface ObserverPacket {
  taskId: string;
  runId: string;
  repository: string;
  objective: string;
  taskState: string;
  terminalSummary: string | null;
  facts: Pick<
    TaskFacts,
    | "phase"
    | "progress"
    | "currentStep"
    | "implementationState"
    | "verificationState"
    | "changedFiles"
    | "verificationSummaries"
    | "recentActivity"
  >;
}

export interface ObserverDraft {
  summary: string;
  risks: string[];
  nextStep: string | null;
}

export interface ObserverBackend {
  readonly model: string;
  observe(packet: ObserverPacket): Promise<ObserverDraft>;
}

export interface PassiveObserverOptions {
  persist: (input: ObserverInterpretationInput) => ObserverInterpretation;
  backend: ObserverBackend;
  emit: (type: string, payload: unknown) => void;
}

function parseObserverDraft(text: string): ObserverDraft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Observer returned no JSON object");
  const value = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Observer result is not an object");
  }
  const record = value as Record<string, unknown>;
  const summary = record["summary"];
  const risks = record["risks"];
  const nextStep = record["nextStep"];
  if (typeof summary !== "string" || !Array.isArray(risks) || !risks.every((risk) => typeof risk === "string")) {
    throw new Error("Observer result has an invalid summary or risks list");
  }
  if (nextStep !== null && typeof nextStep !== "string") {
    throw new Error("Observer nextStep must be a string or null");
  }
  return {
    summary: summary.trim().slice(0, 2_000),
    risks: risks.map((risk) => risk.trim()).filter(Boolean).slice(0, 8),
    nextStep: nextStep?.trim().slice(0, 1_000) || null,
  };
}

export class OmpObserverBackend implements ObserverBackend {
  #model: string;
  readonly #authStorage: NonNullable<CreateAgentSessionOptions["authStorage"]> | undefined;

  constructor(
    model: string,
    authStorage?: NonNullable<CreateAgentSessionOptions["authStorage"]>,
  ) {
    this.#model = model;
    this.#authStorage = authStorage;
  }

  get model(): string {
    return this.#model;
  }

  configure(model: string): void {
    this.#model = model.trim();
  }

  async observe(packet: ObserverPacket): Promise<ObserverDraft> {
    if (!this.#model) throw new Error("No passive observer model is configured");
    const blockTools: ExtensionFactory = (pi) => {
      pi.on("tool_call", (_event, context) => {
        context.abort();
        return { block: true, reason: "The passive observer cannot execute tools" };
      });
    };
    const created = await createAgentSession({
      cwd: packet.repository,
      modelPattern: this.#model,
      ...(this.#authStorage ? { authStorage: this.#authStorage } : {}),
      thinkingLevel: ThinkingLevel.Minimal,
      extensions: [blockTools],
      autoApprove: false,
      hasUI: false,
      enableMCP: false,
      enableIrc: false,
      skipPythonPreflight: true,
      appendSystemPrompt: [
        "You are Mamachi's passive status observer.",
        "You receive only bounded, already-derived task facts. Never claim direct repository access.",
        "Do not call tools. Do not decide task state and do not control the coding agent.",
        "Return one JSON object with exactly: summary (string), risks (string array), nextStep (string or null).",
        "Separate uncertainty from fact. Keep the summary under 80 words.",
      ].join("\n"),
    });
    try {
      await created.session.prompt(JSON.stringify(packet), { expandPromptTemplates: false });
      const text = created.session.getLastAssistantText()?.trim();
      if (!text) throw new Error("Observer returned an empty response");
      return parseObserverDraft(text);
    } finally {
      await created.session.dispose();
    }
  }
}

export class PassiveObserver {
  readonly #persist: (input: ObserverInterpretationInput) => ObserverInterpretation;
  readonly #backend: ObserverBackend;
  readonly #emit: (type: string, payload: unknown) => void;
  readonly #pending = new Map<string, ObserverPacket>();
  readonly #running = new Map<string, Promise<void>>();

  constructor(options: PassiveObserverOptions) {
    this.#persist = options.persist;
    this.#backend = options.backend;
    this.#emit = options.emit;
  }

  observe(packet: ObserverPacket): void {
    this.#pending.set(packet.taskId, packet);
    if (this.#running.has(packet.taskId)) return;
    const operation = this.#drain(packet.taskId).finally(() => this.#running.delete(packet.taskId));
    this.#running.set(packet.taskId, operation);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }

  async #drain(taskId: string): Promise<void> {
    while (this.#pending.has(taskId)) {
      const packet = this.#pending.get(taskId);
      this.#pending.delete(taskId);
      if (!packet) continue;
      try {
        const draft = await this.#backend.observe(packet);
        const input: ObserverInterpretationInput = {
          taskId: packet.taskId,
          runId: packet.runId,
          summary: draft.summary,
          risks: draft.risks,
          nextStep: draft.nextStep,
          model: this.#backend.model,
        };
        const interpretation: ObserverInterpretation = this.#persist(input);
        this.#emit("observer.interpretation", interpretation);
      } catch (error) {
        this.#emit("observer.error", {
          taskId,
          model: this.#backend.model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
