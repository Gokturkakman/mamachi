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

  test("accepts exact approval decisions and rejects model-supplied scope", () => {
    const confirmationId = Bun.randomUUIDv7();
    const command = {
      id: Bun.randomUUIDv7(),
      type: "approval.resolve",
      actor: "ui",
      expectedRevision: 3,
      payload: { confirmationId, decision: "approve" },
    };

    expect(parseCommand(command).type).toBe("approval.resolve");
    expect(() =>
      parseCommand({
        ...command,
        payload: { confirmationId, decision: "approve", appliesTo: "all future actions" },
      }),
    ).toThrow(ProtocolValidationError);
  });

  test("binds question answers to one task, revision, run, and question ID", () => {
    const taskId = Bun.randomUUIDv7();
    const questionId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    const command = {
      id: Bun.randomUUIDv7(),
      type: "task.answerQuestion",
      actor: "ui",
      expectedRevision: 4,
      payload: { taskId, questionId, answer: "Use the staging target." },
    };
    expect(parseCommand(command).type).toBe("task.answerQuestion");
    expect(() =>
      parseCommand({ ...command, payload: { taskId, answer: "An unbound answer" } }),
    ).toThrow(ProtocolValidationError);

    const correlationId = Bun.randomUUIDv7();
    const asked = {
      version: 1,
      id: Bun.randomUUIDv7(),
      seq: 2,
      at: new Date().toISOString(),
      type: "task.questionAsked",
      actor: "coder",
      projectId: "repo_alpha",
      taskId,
      runId,
      correlationId,
      causedBy: correlationId,
      payload: {
        questionId,
        runId,
        revision: 4,
        question: "Which deployment target should I use?",
      },
    };
    expect(parseDomainEvent(asked).type).toBe("task.questionAsked");
    expect(() =>
      parseDomainEvent({
        ...asked,
        payload: { questionId, revision: 4, question: "Missing the bound run" },
      }),
    ).toThrow(ProtocolValidationError);
  });

  test("validates bounded workspace conflict events", () => {
    const taskId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    const correlationId = Bun.randomUUIDv7();
    const event = {
      version: 1,
      id: Bun.randomUUIDv7(),
      seq: 9,
      at: new Date().toISOString(),
      type: "workspace.conflictDetected",
      actor: "coder",
      projectId: "repo_alpha",
      taskId,
      runId,
      correlationId,
      causedBy: correlationId,
      payload: {
        runId,
        paths: ["src/feature.ts"],
        reason: "The user changed a target file",
      },
    };

    expect(parseDomainEvent(event).type).toBe("workspace.conflictDetected");
    expect(() =>
      parseDomainEvent({
        ...event,
        payload: { ...event.payload, content: "source must not enter conflict events" },
      }),
    ).toThrow(ProtocolValidationError);
  });
});
