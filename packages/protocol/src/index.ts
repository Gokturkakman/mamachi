import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { FromSchema } from "json-schema-to-ts";

const uuidV7Pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const IdSchema = {
  type: "string",
  pattern: uuidV7Pattern,
} as const;

export const TaskSpecSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    repositoryId: { type: "string", minLength: 1 },
    objective: { type: "string", minLength: 1 },
    acceptanceCriteria: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    constraints: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    attachmentIds: {
      type: "array",
      items: IdSchema,
      uniqueItems: true,
    },
    codingProfileId: {
      oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
  },
  required: [
    "repositoryId",
    "objective",
    "acceptanceCriteria",
    "constraints",
    "attachmentIds",
    "codingProfileId",
  ],
} as const;

export type TaskSpec = FromSchema<typeof TaskSpecSchema>;

const commandBaseProperties = {
  id: IdSchema,
  actor: { enum: ["user", "voice", "ui", "vscode"] },
} as const;

const taskIdentityPayloadProperties = {
  taskId: IdSchema,
} as const;

export const CommandSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commandBaseProperties,
        type: { const: "task.submit" },
        expectedRevision: { type: "null" },
        payload: TaskSpecSchema,
      },
      required: ["id", "type", "actor", "expectedRevision", "payload"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commandBaseProperties,
        type: { const: "task.requestPause" },
        expectedRevision: { type: "integer", minimum: 1 },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...taskIdentityPayloadProperties,
            reason: { type: "string", minLength: 1 },
          },
          required: ["taskId", "reason"],
        },
      },
      required: ["id", "type", "actor", "expectedRevision", "payload"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commandBaseProperties,
        type: { const: "task.revise" },
        expectedRevision: { type: "integer", minimum: 1 },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...taskIdentityPayloadProperties,
            spec: TaskSpecSchema,
          },
          required: ["taskId", "spec"],
        },
      },
      required: ["id", "type", "actor", "expectedRevision", "payload"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commandBaseProperties,
        type: { const: "task.resume" },
        expectedRevision: { type: "integer", minimum: 1 },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: taskIdentityPayloadProperties,
          required: ["taskId"],
        },
      },
      required: ["id", "type", "actor", "expectedRevision", "payload"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commandBaseProperties,
        type: { const: "task.cancel" },
        expectedRevision: { type: "integer", minimum: 1 },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...taskIdentityPayloadProperties,
            reason: { type: "string", minLength: 1 },
          },
          required: ["taskId", "reason"],
        },
      },
      required: ["id", "type", "actor", "expectedRevision", "payload"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...commandBaseProperties,
        type: { const: "queue.move" },
        expectedRevision: { type: "null" },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...taskIdentityPayloadProperties,
            operation: {
              enum: ["move_first", "move_last", "move_before", "move_after"],
            },
            anchorTaskId: {
              oneOf: [IdSchema, { type: "null" }],
            },
          },
          required: ["taskId", "operation", "anchorTaskId"],
        },
      },
      required: ["id", "type", "actor", "expectedRevision", "payload"],
    },
  ],
} as const;

export type Command = FromSchema<typeof CommandSchema>;
export type CommandType = Command["type"];

export const EventPayloadSchemas = {
  "task.created": {
    type: "object",
    additionalProperties: false,
    properties: {
      spec: TaskSpecSchema,
      revision: { type: "integer", minimum: 1 },
    },
    required: ["spec", "revision"],
  },
  "task.enqueued": {
    type: "object",
    additionalProperties: false,
    properties: {
      position: { type: "integer", minimum: 0 },
    },
    required: ["position"],
  },
  "task.started": {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: IdSchema,
      revision: { type: "integer", minimum: 1 },
    },
    required: ["runId", "revision"],
  },
  "task.pauseRequested": {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string", minLength: 1 },
    },
    required: ["reason"],
  },
  "task.paused": {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: IdSchema,
      reason: { type: "string", minLength: 1 },
    },
    required: ["runId", "reason"],
  },
  "task.specRevised": {
    type: "object",
    additionalProperties: false,
    properties: {
      previousRevision: { type: "integer", minimum: 1 },
      revision: { type: "integer", minimum: 2 },
      spec: TaskSpecSchema,
    },
    required: ["previousRevision", "revision", "spec"],
  },
  "task.resumed": {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: IdSchema,
      revision: { type: "integer", minimum: 1 },
    },
    required: ["runId", "revision"],
  },
  "task.completed": {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: IdSchema,
      summary: { type: "string", minLength: 1 },
      evidenceIds: {
        type: "array",
        items: IdSchema,
        uniqueItems: true,
      },
    },
    required: ["runId", "summary", "evidenceIds"],
  },
  "task.failed": {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: IdSchema,
      error: { type: "string", minLength: 1 },
    },
    required: ["runId", "error"],
  },
  "task.cancelled": {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string", minLength: 1 },
    },
    required: ["reason"],
  },
  "run.interrupted": {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: IdSchema,
      reason: { type: "string", minLength: 1 },
    },
    required: ["runId", "reason"],
  },
  "queue.reordered": {
    type: "object",
    additionalProperties: false,
    properties: {
      taskIds: {
        type: "array",
        items: IdSchema,
        uniqueItems: true,
      },
    },
    required: ["taskIds"],
  },
} as const;

export interface EventPayloadByType {
  "task.created": FromSchema<(typeof EventPayloadSchemas)["task.created"]>;
  "task.enqueued": FromSchema<(typeof EventPayloadSchemas)["task.enqueued"]>;
  "task.started": FromSchema<(typeof EventPayloadSchemas)["task.started"]>;
  "task.pauseRequested": FromSchema<(typeof EventPayloadSchemas)["task.pauseRequested"]>;
  "task.paused": FromSchema<(typeof EventPayloadSchemas)["task.paused"]>;
  "task.specRevised": FromSchema<(typeof EventPayloadSchemas)["task.specRevised"]>;
  "task.resumed": FromSchema<(typeof EventPayloadSchemas)["task.resumed"]>;
  "task.completed": FromSchema<(typeof EventPayloadSchemas)["task.completed"]>;
  "task.failed": FromSchema<(typeof EventPayloadSchemas)["task.failed"]>;
  "task.cancelled": FromSchema<(typeof EventPayloadSchemas)["task.cancelled"]>;
  "run.interrupted": FromSchema<(typeof EventPayloadSchemas)["run.interrupted"]>;
  "queue.reordered": FromSchema<(typeof EventPayloadSchemas)["queue.reordered"]>;
}

export type EventType = keyof EventPayloadByType;
export type EventPayload<T extends EventType> = EventPayloadByType[T];

export type EventActor = "controller" | "policy" | "coder" | "voice" | "ui" | "vscode";

type EventFor<T extends EventType> = {
  version: 1;
  id: string;
  seq: number;
  at: string;
  type: T;
  actor: EventActor;
  projectId?: string;
  taskId?: string;
  runId?: string;
  correlationId: string;
  causedBy?: string;
  payload: EventPayload<T>;
};

export type DomainEvent<T extends EventType = EventType> = T extends EventType ? EventFor<T> : never;
export type NewDomainEvent<T extends EventType = EventType> = T extends EventType
  ? Omit<EventFor<T>, "seq">
  : never;

export const ActionResultSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { const: "accepted" },
        eventId: IdSchema,
        taskId: IdSchema,
      },
      required: ["status", "eventId"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { const: "confirmation_required" },
        confirmationId: IdSchema,
        summary: { type: "string", minLength: 1 },
      },
      required: ["status", "confirmationId", "summary"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { const: "rejected" },
        code: { type: "string", minLength: 1 },
        explanation: { type: "string", minLength: 1 },
      },
      required: ["status", "code", "explanation"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { const: "conflict" },
        currentRevision: { type: "integer", minimum: 1 },
        explanation: { type: "string", minLength: 1 },
      },
      required: ["status", "currentRevision", "explanation"],
    },
  ],
} as const;

export type ActionResult = FromSchema<typeof ActionResultSchema>;

const DomainEventEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    id: IdSchema,
    seq: { type: "integer", minimum: 1 },
    at: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    actor: { enum: ["controller", "policy", "coder", "voice", "ui", "vscode"] },
    projectId: { type: "string", minLength: 1 },
    taskId: IdSchema,
    runId: IdSchema,
    correlationId: IdSchema,
    causedBy: IdSchema,
    payload: { type: "object" },
  },
  required: ["version", "id", "seq", "at", "type", "actor", "correlationId", "payload"],
} as const;

export class ProtocolValidationError extends Error {
  readonly errors: ErrorObject[];

  constructor(message: string, errors: ErrorObject[] = []) {
    super(message);
    this.name = "ProtocolValidationError";
    this.errors = errors;
  }
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateCommand = ajv.compile(CommandSchema);
const validateActionResult = ajv.compile(ActionResultSchema);
const validateEventEnvelope = ajv.compile(DomainEventEnvelopeSchema);
const validateEventPayload = Object.fromEntries(
  Object.entries(EventPayloadSchemas).map(([type, schema]) => [type, ajv.compile(schema)]),
) as Record<EventType, ValidateFunction>;

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "unknown validation error";
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export function parseCommand(input: unknown): Command {
  if (!validateCommand(input)) {
    const errors = validateCommand.errors ?? [];
    throw new ProtocolValidationError(`Invalid command: ${validationMessage(errors)}`, errors);
  }
  return input as Command;
}

export function parseActionResult(input: unknown): ActionResult {
  if (!validateActionResult(input)) {
    const errors = validateActionResult.errors ?? [];
    throw new ProtocolValidationError(`Invalid action result: ${validationMessage(errors)}`, errors);
  }
  return input as ActionResult;
}

export function parseDomainEvent(input: unknown): DomainEvent {
  if (!validateEventEnvelope(input)) {
    const errors = validateEventEnvelope.errors ?? [];
    throw new ProtocolValidationError(`Invalid event envelope: ${validationMessage(errors)}`, errors);
  }

  const candidate = input as { type: string; payload: unknown };
  if (!(candidate.type in validateEventPayload)) {
    throw new ProtocolValidationError(`Unknown event type: ${candidate.type}`);
  }

  const validator = validateEventPayload[candidate.type as EventType];
  if (!validator(candidate.payload)) {
    const errors = validator.errors ?? [];
    throw new ProtocolValidationError(
      `Invalid ${candidate.type} payload: ${validationMessage(errors)}`,
      errors,
    );
  }

  return input as DomainEvent;
}
