import { describe, expect, test } from "bun:test";
import {
  parseCommand,
  parseDomainEvent,
  ProtocolValidationError,
} from "../src/index.ts";

const taskSpec = {
  repositoryId: "repo_alpha",
  objective: "Change an observable behavior",
  acceptanceCriteria: ["The behavior is verified"],
  constraints: [],
  attachmentIds: [],
  codingProfileId: null,
};

describe("canonical protocol validation", () => {
  test("accepts a strict task submission", () => {
    const command = {
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: taskSpec,
    };

    const parsed = parseCommand(command);
    expect(parsed.type).toBe("task.submit");
    expect(parsed.id).toBe(command.id);
  });

  test("rejects unknown command properties and malformed identifiers", () => {
    expect(() =>
      parseCommand({
        id: "not-a-uuid",
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: taskSpec,
        risk: "safe",
      }),
    ).toThrow(ProtocolValidationError);
  });

  test("validates event payloads by their exact event type", () => {
    const event = {
      version: 1,
      id: Bun.randomUUIDv7(),
      seq: 1,
      at: new Date().toISOString(),
      type: "task.started",
      actor: "controller",
      projectId: "repo_alpha",
      taskId: Bun.randomUUIDv7(),
      correlationId: Bun.randomUUIDv7(),
      payload: {
        revision: 1,
      },
    };

    expect(() => parseDomainEvent(event)).toThrow(/runId/);
    expect(
      parseDomainEvent({
        ...event,
        payload: {
          runId: Bun.randomUUIDv7(),
          revision: 1,
        },
      }).type,
    ).toBe("task.started");
  });
});
