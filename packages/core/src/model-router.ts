import type { TaskRecord } from "./domain.ts";
import {
  assistiveComputerCapabilities,
  computerCapabilities,
  computerConfirmationModes,
  isComputerCapability,
} from "./computer-control.ts";
import type {
  ComputerCapability,
  ComputerConfirmationMode,
} from "./computer-control.ts";

export const codingBackends = ["omp", "codex", "claude"] as const;
export type CodingBackend = (typeof codingBackends)[number];

export const thinkingLevels = ["inherit", "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type CodingThinkingLevel = (typeof thinkingLevels)[number];

export interface RuntimeSettings {
  codingBackend: CodingBackend;
  primaryModel: string;
  fastModel: string;
  thinkingLevel: CodingThinkingLevel;
  automaticRouting: boolean;
  computerCapabilities: ComputerCapability[];
  computerConfirmationMode: ComputerConfirmationMode;
}

export const defaultRuntimeSettings: RuntimeSettings = {
  codingBackend: "omp",
  primaryModel: "",
  fastModel: "openai-codex/gpt-5.4-mini",
  thinkingLevel: "inherit",
  automaticRouting: true,
  computerCapabilities: [...assistiveComputerCapabilities],
  computerConfirmationMode: "sensitive",
};

export interface TaskRoute {
  tier: "primary" | "fast" | "explicit";
  modelPattern: string | undefined;
  thinkingLevel: CodingThinkingLevel;
  reason: string;
}

const hardTaskPattern = /\b(architect(?:ure)?|migration|database|schema|authentication|authorization|security|concurren|race condition|multi[- ]file|refactor|performance|production|deploy|release|breaking|protocol|infrastructure)\b/i;
const easyTaskPattern = /\b(search|research|look up|find|list|summari[sz]e|explain|inspect|check|typo|copy|wording|rename|format|documentation|readme)\b/i;

export function isEasyTask(task: TaskRecord): boolean {
  if (task.spec.codingProfileId === "fast") return true;
  const text = [task.spec.objective, ...task.spec.acceptanceCriteria, ...task.spec.constraints].join(" ");
  if (text.length > 700 || task.spec.acceptanceCriteria.length > 3 || task.spec.constraints.length > 4) return false;
  if (hardTaskPattern.test(text)) return false;
  return easyTaskPattern.test(text) || (task.spec.objective.length <= 100 && task.spec.acceptanceCriteria.length === 1);
}

export function resolveTaskRoute(task: TaskRecord, settings: RuntimeSettings): TaskRoute {
  const profile = task.spec.codingProfileId;
  if (profile && !["auto", "primary", "fast"].includes(profile)) {
    return {
      tier: "explicit",
      modelPattern: profile,
      thinkingLevel: settings.thinkingLevel,
      reason: "task requested an explicit coding profile",
    };
  }

  const useFast = profile === "fast" || (profile !== "primary" && settings.automaticRouting && isEasyTask(task));
  if (useFast && settings.fastModel.trim()) {
    return {
      tier: "fast",
      modelPattern: settings.fastModel.trim(),
      thinkingLevel: settings.thinkingLevel,
      reason: profile === "fast" ? "task requested the fast route" : "router classified the task as easy",
    };
  }

  return {
    tier: "primary",
    modelPattern: settings.primaryModel.trim() || undefined,
    thinkingLevel: settings.thinkingLevel,
    reason: settings.automaticRouting ? "router kept the task on the primary model" : "automatic routing is disabled",
  };
}

export function parseRuntimeSettings(input: unknown): RuntimeSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("settings.update payload must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  const expected = [
    "codingBackend",
    "primaryModel",
    "fastModel",
    "thinkingLevel",
    "automaticRouting",
    "computerCapabilities",
    "computerConfirmationMode",
  ];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("settings.update payload has unexpected fields");
  }
  const codingBackend = value["codingBackend"];
  const primaryModel = value["primaryModel"];
  const fastModel = value["fastModel"];
  const thinkingLevel = value["thinkingLevel"];
  const automaticRouting = value["automaticRouting"];
  const configuredComputerCapabilities = value["computerCapabilities"];
  const computerConfirmationMode = value["computerConfirmationMode"];
  if (typeof codingBackend !== "string" || !codingBackends.includes(codingBackend as CodingBackend)) {
    throw new Error(`codingBackend must be one of: ${codingBackends.join(", ")}`);
  }
  if (typeof primaryModel !== "string" || primaryModel.length > 200) {
    throw new Error("primaryModel must be a string of at most 200 characters");
  }
  if (typeof fastModel !== "string" || fastModel.length > 200) {
    throw new Error("fastModel must be a string of at most 200 characters");
  }
  if (typeof thinkingLevel !== "string" || !thinkingLevels.includes(thinkingLevel as CodingThinkingLevel)) {
    throw new Error(`thinkingLevel must be one of: ${thinkingLevels.join(", ")}`);
  }
  if (typeof automaticRouting !== "boolean") {
    throw new Error("automaticRouting must be a boolean");
  }
  if (
    !Array.isArray(configuredComputerCapabilities) ||
    configuredComputerCapabilities.some((capability) => !isComputerCapability(capability)) ||
    new Set(configuredComputerCapabilities).size !== configuredComputerCapabilities.length
  ) {
    throw new Error(
      `computerCapabilities must contain unique values from: ${computerCapabilities.join(", ")}`,
    );
  }
  if (
    typeof computerConfirmationMode !== "string" ||
    !computerConfirmationModes.includes(computerConfirmationMode as ComputerConfirmationMode)
  ) {
    throw new Error(
      `computerConfirmationMode must be one of: ${computerConfirmationModes.join(", ")}`,
    );
  }
  return {
    codingBackend: codingBackend as CodingBackend,
    primaryModel: primaryModel.trim(),
    fastModel: fastModel.trim(),
    thinkingLevel: thinkingLevel as CodingThinkingLevel,
    automaticRouting,
    computerCapabilities: configuredComputerCapabilities as ComputerCapability[],
    computerConfirmationMode: computerConfirmationMode as ComputerConfirmationMode,
  };
}
