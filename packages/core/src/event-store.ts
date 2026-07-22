import { Database } from "bun:sqlite";
import {
  parseActionResult,
  parseDomainEvent,
  type ActionResult,
  type DomainEvent,
  type NewDomainEvent,
} from "@mamachi/protocol";

interface EventRow {
  seq: number;
  id: string;
  at: string;
  type: string;
  actor: string;
  project_id: string | null;
  task_id: string | null;
  run_id: string | null;
  correlation_id: string;
  caused_by: string | null;
  payload_json: string;
}

interface CommandRow {
  result_json: string;
}

export interface CommandRecord {
  id: string;
  type: string;
  actor: string;
  expectedRevision: number | null;
  payload: unknown;
  createdAt: string;
}

export interface CommandDecision {
  result: ActionResult;
  events: NewDomainEvent[];
}

export interface CommandExecution {
  result: ActionResult;
  events: DomainEvent[];
  replayed: boolean;
}

export class EventStore {
  readonly #db: Database;

  constructor(path = ":memory:") {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.run("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") this.#db.run("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

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

      CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS events_type_seq ON events(type, seq);
    `);

    this.#db
      .query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(1, new Date().toISOString());
  }

  executeCommand(command: CommandRecord, decide: () => CommandDecision): CommandExecution {
    const transaction = this.#db.transaction((): CommandExecution => {
      const existing = this.#db
        .query<CommandRow, [string]>("SELECT result_json FROM commands WHERE id = ?")
        .get(command.id);
      if (existing) {
        return {
          result: parseActionResult(JSON.parse(existing.result_json)),
          events: [],
          replayed: true,
        };
      }

      const decision = decide();
      const storedEvents: DomainEvent[] = [];
      const insertEvent = this.#db.query(`
        INSERT INTO events(
          id, at, type, actor, project_id, task_id, run_id,
          correlation_id, caused_by, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const event of decision.events) {
        const inserted = insertEvent.run(
          event.id,
          event.at,
          event.type,
          event.actor,
          event.projectId ?? null,
          event.taskId ?? null,
          event.runId ?? null,
          event.correlationId,
          event.causedBy ?? null,
          JSON.stringify(event.payload),
        );
        const seq = Number(inserted.lastInsertRowid);
        storedEvents.push(parseDomainEvent({ ...event, seq }));
      }

      this.#db
        .query(`
          INSERT INTO commands(
            id, type, actor, expected_revision, payload_json, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          command.id,
          command.type,
          command.actor,
          command.expectedRevision,
          JSON.stringify(command.payload),
          JSON.stringify(decision.result),
          command.createdAt,
        );

      return {
        result: decision.result,
        events: storedEvents,
        replayed: false,
      };
    });

    return transaction.immediate();
  }

  readAfter(afterSeq = 0): DomainEvent[] {
    const rows = this.#db
      .query<EventRow, [number]>(`
        SELECT
          seq, id, at, type, actor, project_id, task_id, run_id,
          correlation_id, caused_by, payload_json
        FROM events
        WHERE seq > ?
        ORDER BY seq ASC
      `)
      .all(afterSeq);

    return rows.map((row) =>
      parseDomainEvent({
        version: 1,
        id: row.id,
        seq: row.seq,
        at: row.at,
        type: row.type,
        actor: row.actor,
        ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.task_id ? { taskId: row.task_id } : {}),
        ...(row.run_id ? { runId: row.run_id } : {}),
        correlationId: row.correlation_id,
        ...(row.caused_by ? { causedBy: row.caused_by } : {}),
        payload: JSON.parse(row.payload_json),
      }),
    );
  }

  eventCount(): number {
    const row = this.#db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get();
    return row?.count ?? 0;
  }

  close(): void {
    this.#db.close();
  }
}
