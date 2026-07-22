import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "../src/domain.ts";
import {
  defaultRuntimeSettings,
  parseRuntimeSettings,
  resolveTaskRoute,
  type RuntimeSettings,
} from "../src/model-router.ts";

function task(objective: string, codingProfileId: string | null = null): TaskRecord {
  const id = Bun.randomUUIDv7();
  return {
    id,
    repositoryId: "/tmp/project",
    state: "running",
    spec: {
      repositoryId: "/tmp/project",
      objective,
      acceptanceCriteria: ["Return a concise, sourced result"],
      constraints: [],
      attachmentIds: [],
      codingProfileId,
    },
    revision: 1,
    activeRunId: Bun.randomUUIDv7(),
    runIds: [],
    evidenceIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    terminalSummary: null,
    workspaceConflict: null,
    ompSession: null,
    pendingQuestion: null,
    specHistory: [{ revision: 1, objective, revisedAt: new Date(0).toISOString() }],
  };
}

const configured: RuntimeSettings = {
  primaryModel: "openai-codex/gpt-5.6-sol",
  fastModel: "openai-codex/gpt-5.4-mini",
  thinkingLevel: "medium",
  automaticRouting: true,
};

describe("model router", () => {
  test("routes simple research to the configured fast model", () => {
    expect(resolveTaskRoute(task("Research and list today's confirmed fixtures"), configured)).toEqual({
      tier: "fast",
      modelPattern: "openai-codex/gpt-5.4-mini",
      thinkingLevel: "medium",
      reason: "router classified the task as easy",
    });
  });

  test("keeps load-bearing work on the primary model", () => {
    const route = resolveTaskRoute(task("Refactor the authentication architecture and migrate the database schema"), configured);
    expect(route.tier).toBe("primary");
    expect(route.modelPattern).toBe("openai-codex/gpt-5.6-sol");
  });

  test("honors explicit model and fast profile overrides", () => {
    expect(resolveTaskRoute(task("Implement the requested change", "anthropic/claude-fable-5"), configured).tier).toBe("explicit");
    expect(resolveTaskRoute(task("Investigate an unfamiliar topic", "fast"), configured).tier).toBe("fast");
  });

  test("validates complete runtime settings payloads", () => {
    expect(parseRuntimeSettings(defaultRuntimeSettings)).toEqual(defaultRuntimeSettings);
    expect(() => parseRuntimeSettings({ ...defaultRuntimeSettings, thinkingLevel: "reckless" })).toThrow();
  });
});
