import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../src/artifact-store.ts";
import { EventStore } from "../src/event-store.ts";
import { STORAGE_SCHEMA_VERSION } from "../src/storage-schema.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function legacyV1Fixture(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, '2025-01-01T00:00:00.000Z');
    CREATE TABLE commands (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, actor TEXT NOT NULL, expected_revision INTEGER,
      payload_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
      type TEXT NOT NULL, actor TEXT NOT NULL, project_id TEXT, task_id TEXT, run_id TEXT,
      correlation_id TEXT NOT NULL, caused_by TEXT, payload_json TEXT NOT NULL
    );
    CREATE TABLE context_artifacts (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace TEXT NOT NULL, summary TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
      run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL, kind TEXT NOT NULL,
      summary TEXT NOT NULL, successful INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO commands VALUES (
      '018f0000-0000-7000-8000-000000000001', 'task.create', 'user', NULL, '{}',
      '{"status":"accepted","eventId":"018f0000-0000-7000-8000-000000000002"}', '2025-01-01T00:00:00.000Z'
    );
    INSERT INTO events (
      id, at, type, actor, correlation_id, payload_json
    ) VALUES (
      '018f0000-0000-7000-8000-000000000002', '2025-01-01T00:00:00.000Z', 'task.created',
      'controller', '018f0000-0000-7000-8000-000000000001', '{}'
    );
    INSERT INTO context_artifacts VALUES (
      'context-1', 'active_file', '/tmp/project', 'legacy context', '{"path":"README"}', '2025-01-01T00:00:00.000Z'
    );
    INSERT INTO artifacts (
      id, task_id, run_id, tool_call_id, tool_name, kind, summary, successful, payload_json, created_at
    ) VALUES (
      'artifact-1', 'task-1', 'run-1', 'call-1', 'read', 'tool_result', 'legacy artifact', 1, '{}',
      '2025-01-01T00:00:00.000Z'
    );
  `);
  db.close();
}

describe("storage schema migrations", () => {
  test("upgrades a legacy v1 database without changing durable truth or artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-storage-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "legacy.sqlite");
    legacyV1Fixture(path);

    new EventStore(path).close();
    new ArtifactStore(path).close();

    const db = new Database(path, { strict: true });
    const requiredTables = [
      "artifacts", "commands", "confirmations", "events", "intent_drafts", "memories", "projects",
      "questions", "runs", "schema_migrations", "task_spec_revisions", "tasks", "transcript_turns",
      "voice_sessions",
    ];
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((row) => row.name);
    for (const table of requiredTables) expect(tables).toContain(table);

    const indexes = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    ).all().map((row) => row.name);
    for (const index of [
      "confirmations_task_state", "events_task_seq", "intent_drafts_project_updated",
      "memories_project_updated", "questions_run_state", "questions_task_state", "runs_task_started",
      "task_spec_revisions_created", "transcript_turns_session_ordinal", "voice_sessions_project_started",
    ]) expect(indexes).toContain(index);
    const questionColumns = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(questions)").all();
    expect(questionColumns.find((column) => column.name === "run_id")?.notnull).toBe(1);
    expect(questionColumns.find((column) => column.name === "task_revision")?.notnull).toBe(1);

    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM commands").get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()?.count).toBe(1);
    expect(db.query<{ summary: string }, []>("SELECT summary FROM artifacts").get()?.summary).toBe("legacy artifact");
    expect(db.query<{ summary: string }, []>("SELECT summary FROM context_artifacts").get()?.summary).toBe("legacy context");
    expect(db.query<{ version: number }, []>("SELECT max(version) AS version FROM schema_migrations").get()?.version)
      .toBe(STORAGE_SCHEMA_VERSION);
    db.close();
  });

  test("is idempotent and has no raw microphone data column or insertion path", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-storage-idempotent-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");

    new EventStore(path).close();
    const before = new Database(path, { strict: true });
    const migrationsBefore = before.query<{ version: number; applied_at: string }, []>(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    ).all();
    before.close();

    new ArtifactStore(path).close();
    new EventStore(path).close();
    const after = new Database(path, { strict: true });
    expect(after.query<{ version: number; applied_at: string }, []>(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    ).all()).toEqual(migrationsBefore);

    const tables = after.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all();
    const columns = tables.flatMap(({ name }) =>
      after.query<{ name: string }, []>(`PRAGMA table_info(${name})`).all().map((column) => `${name}.${column.name}`),
    );
    expect(columns.some((column) => /(?:raw_?)?audio|microphone/i.test(column))).toBe(false);
    expect(() => after.query(
      "INSERT INTO voice_sessions (id, state, provider_session_id, started_at, raw_audio) VALUES (?, ?, ?, ?, ?)",
    ).run("voice-1", "active", null, "2025-01-01T00:00:00.000Z", new Uint8Array([1, 2, 3]))).toThrow();
    after.close();
  });
});
