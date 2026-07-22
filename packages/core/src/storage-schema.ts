import { Database } from "bun:sqlite";

export const STORAGE_SCHEMA_VERSION = 2;

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        expected_revision INTEGER,
        payload_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        run_id TEXT,
        correlation_id TEXT NOT NULL,
        caused_by TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_artifacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        successful INTEGER NOT NULL CHECK(successful IN (0, 1)),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observer_interpretations (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        next_step TEXT,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS events_type_seq ON events(type, seq);
      CREATE INDEX IF NOT EXISTS observer_task_ordinal ON observer_interpretations(task_id, ordinal DESC);
      CREATE INDEX IF NOT EXISTS artifacts_task_ordinal ON artifacts(task_id, ordinal);
      CREATE INDEX IF NOT EXISTS artifacts_run_ordinal ON artifacts(run_id, ordinal);
    `,
  },
  {
    version: 2,
    sql: `
      -- Legacy v1 databases created event and artifact tables independently. Keep
      -- these definitions here so either historical shape converges on one schema.
      CREATE TABLE IF NOT EXISTS context_artifacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        successful INTEGER NOT NULL CHECK(successful IN (0, 1)),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observer_interpretations (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        next_step TEXT,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_identity TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS voice_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'ended', 'failed')),
        provider_session_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS transcript_turns (
        id TEXT PRIMARY KEY,
        voice_session_id TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        speaker TEXT NOT NULL CHECK(speaker IN ('user', 'assistant')),
        transcript_ciphertext BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(voice_session_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS intent_drafts (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        voice_session_id TEXT REFERENCES voice_sessions(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK(state IN ('draft', 'submitted', 'discarded')),
        draft_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_spec_revisions (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        spec_json TEXT NOT NULL,
        source_command_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, revision)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
        state TEXT NOT NULL,
        recovery_json TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS confirmations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
        state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'rejected', 'consumed')),
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        effect_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
        state TEXT NOT NULL CHECK(state IN ('open', 'answered', 'cancelled')),
        question_ciphertext BLOB NOT NULL,
        answer_ciphertext BLOB,
        asked_at TEXT NOT NULL,
        answered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('confirmed_fact', 'explicit_memory')),
        content_ciphertext BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS events_type_seq ON events(type, seq);
      CREATE INDEX IF NOT EXISTS observer_task_ordinal ON observer_interpretations(task_id, ordinal DESC);
      CREATE INDEX IF NOT EXISTS artifacts_task_ordinal ON artifacts(task_id, ordinal);
      CREATE INDEX IF NOT EXISTS artifacts_run_ordinal ON artifacts(run_id, ordinal);
      CREATE INDEX IF NOT EXISTS voice_sessions_project_started ON voice_sessions(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS transcript_turns_session_ordinal ON transcript_turns(voice_session_id, ordinal);
      CREATE INDEX IF NOT EXISTS intent_drafts_project_updated ON intent_drafts(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_project_updated ON tasks(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS task_spec_revisions_created ON task_spec_revisions(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS runs_task_started ON runs(task_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS confirmations_task_state ON confirmations(task_id, state, created_at DESC);
      CREATE INDEX IF NOT EXISTS questions_task_state ON questions(task_id, state, asked_at DESC);
      CREATE INDEX IF NOT EXISTS questions_run_state ON questions(run_id, state, asked_at DESC);
      CREATE INDEX IF NOT EXISTS memories_project_updated ON memories(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_task_updated ON memories(task_id, updated_at DESC);
    `,
  },
];

export function migrateStorage(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
  })();

  const applied = new Set(
    db.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    })();
  }
}
