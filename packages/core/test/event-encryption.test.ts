import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "@mamachi/protocol";
import { TaskController } from "../src/controller.ts";
import { EventStore } from "../src/event-store.ts";
import { MemoryStore } from "../src/memory-store.ts";

const encryptionKey = new Uint8Array(32).fill(0x5a);

function submitCommand(secret: string): Command {
  return {
    id: Bun.randomUUIDv7(),
    type: "task.submit",
    actor: "voice",
    expectedRevision: null,
    payload: {
      repositoryId: "/tmp/mamachi-encrypted-events",
      objective: `Implement ${secret}`,
      acceptanceCriteria: [`Verify ${secret}`],
      constraints: ["Preserve existing work"],
      attachmentIds: [],
      codingProfileId: "openai-codex/gpt-5.6-sol",
    },
  };
}

describe("encrypted event persistence", () => {
  test("encrypts command and event payloads while preserving replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-event-encryption-"));
    const path = join(directory, "state.sqlite");
    const secret = "private-customer-incident-7421";
    const command = submitCommand(secret);
    try {
      const store = new EventStore(path, { encryptionKey });
      const controller = new TaskController(store);
      const submitted = controller.handle(command);
      expect(submitted.status).toBe("accepted");
      store.close();

      const database = new Database(path, { strict: true });
      const event = database.query<{ payload_json: string }, []>("SELECT payload_json FROM events LIMIT 1").get();
      const storedCommand = database
        .query<{ payload_json: string; result_json: string }, []>(
          "SELECT payload_json, result_json FROM commands LIMIT 1",
        )
        .get();
      expect(event?.payload_json.startsWith("mamachi:aes256gcm:v1:")).toBe(true);
      expect(storedCommand?.payload_json.startsWith("mamachi:aes256gcm:v1:")).toBe(true);
      expect(storedCommand?.result_json.startsWith("mamachi:aes256gcm:v1:")).toBe(true);
      expect(`${event?.payload_json}${storedCommand?.payload_json}${storedCommand?.result_json}`).not.toContain(secret);
      database.close();

      const reopened = new EventStore(path, { encryptionKey });
      const restored = new TaskController(reopened);
      expect(restored.snapshot().tasks[0]?.spec.objective).toBe(`Implement ${secret}`);
      expect(restored.handle(command)).toEqual(submitted);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("encrypts legacy plaintext events when a key becomes available", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-event-migration-"));
    const path = join(directory, "state.sqlite");
    const secret = "legacy-private-objective";
    try {
      const plaintext = new EventStore(path);
      new TaskController(plaintext).handle(submitCommand(secret));
      plaintext.close();

      const encrypted = new EventStore(path, { encryptionKey });
      expect(new TaskController(encrypted).snapshot().tasks[0]?.spec.objective).toBe(`Implement ${secret}`);
      encrypted.close();

      const database = new Database(path, { strict: true });
      const values = database
        .query<{ payload_json: string; result_json: string | null }, []>(
          `SELECT payload_json, NULL AS result_json FROM events
           UNION ALL
           SELECT payload_json, result_json FROM commands`,
        )
        .all()
        .flatMap((row) => [row.payload_json, ...(row.result_json === null ? [] : [row.result_json])]);
      expect(values.every((value) => value.startsWith("mamachi:aes256gcm:v1:"))).toBe(true);
      expect(values.join("")).not.toContain(secret);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("encrypts legacy explicit memories when a key becomes available", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-memory-migration-"));
    const path = join(directory, "state.sqlite");
    const secret = "remember the private service topology";
    try {
      const plaintext = new MemoryStore(path);
      const memory = plaintext.remember("global", null, secret);
      plaintext.close();

      const encrypted = new MemoryStore(path, encryptionKey);
      expect(encrypted.get(memory.id)?.fact).toBe(secret);
      encrypted.close();

      const database = new Database(path, { strict: true });
      const stored = database
        .query<{ content_ciphertext: string }, [string]>(
          "SELECT content_ciphertext FROM memories WHERE id = ?",
        )
        .get(memory.id)?.content_ciphertext;
      expect(stored?.startsWith("mamachi:aes256gcm:v1:")).toBe(true);
      expect(stored).not.toContain(secret);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("repairs encrypted OMP session events written before backend selection", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-session-backend-migration-"));
    const path = join(directory, "state.sqlite");
    const eventId = Bun.randomUUIDv7();
    const taskId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    try {
      const initialized = new EventStore(path, { encryptionKey });
      initialized.close();

      const legacy = new Database(path, { strict: true });
      legacy
        .query(`
          INSERT INTO events(
            id, at, type, actor, project_id, task_id, run_id,
            correlation_id, caused_by, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          eventId,
          new Date(0).toISOString(),
          "coder.sessionBound",
          "coder",
          null,
          taskId,
          runId,
          eventId,
          null,
          JSON.stringify({
            sessionId: "legacy-omp-session",
            sessionFile: "/tmp/legacy-omp-session.jsonl",
            runId,
          }),
        );
      legacy.close();

      const migrated = new EventStore(path, { encryptionKey });
      const [event] = migrated.readAfter();
      expect(event?.type).toBe("coder.sessionBound");
      if (!event || event.type !== "coder.sessionBound") {
        throw new Error("Expected migrated coder.sessionBound event");
      }
      expect(event.payload.backend).toBe("omp");
      migrated.close();

      const stored = new Database(path, { strict: true });
      const payload = stored
        .query<{ payload_json: string }, [string]>(
          "SELECT payload_json FROM events WHERE id = ?",
        )
        .get(eventId)?.payload_json;
      expect(payload?.startsWith("mamachi:aes256gcm:v1:")).toBe(true);
      stored.close();

      const reopened = new EventStore(path, { encryptionKey });
      const replayed = reopened.readAfter()[0];
      expect(replayed?.type).toBe("coder.sessionBound");
      if (replayed?.type === "coder.sessionBound") {
        expect(replayed.payload.backend).toBe("omp");
      }
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
