import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_SCHEMA,
  COMMAND_TYPES,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  PROTOCOL_ENVELOPE_VERSION,
  PROTOCOL_SCHEMA_SHA256,
} from "../generated/typescript/protocol.generated.ts";
import { CommandSchema, EventPayloadSchemas } from "../src/index.ts";

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("generated client bindings", () => {
  test("are current with the canonical protocol schemas", () => {
    const check = Bun.spawnSync(["bun", "scripts/generate-bindings.ts", "--check"], {
      cwd: protocolRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(check.stderr)).toBe("");
    expect(check.exitCode).toBe(0);
    const generatedCommandSchema: unknown = COMMAND_SCHEMA;
    const generatedEventSchemas: unknown = EVENT_PAYLOAD_SCHEMAS;
    const generatedCommandTypes: readonly string[] = COMMAND_TYPES;
    const generatedEventTypes: readonly string[] = EVENT_TYPES;
    const canonicalCommandTypes: readonly string[] = CommandSchema.oneOf.map((variant) => variant.properties.type.const);
    const canonicalEventTypes: readonly string[] = Object.keys(EventPayloadSchemas);
    expect(generatedCommandSchema).toEqual(CommandSchema);
    expect(generatedEventSchemas).toEqual(EventPayloadSchemas);
    expect(generatedCommandTypes).toEqual(canonicalCommandTypes);
    expect(generatedEventTypes).toEqual(canonicalEventTypes);
    expect(PROTOCOL_ENVELOPE_VERSION).toBe(1);
    expect(PROTOCOL_SCHEMA_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
