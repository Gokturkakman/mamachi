import { Database } from "bun:sqlite";
import {
  parseActionResult,
  parseDomainEvent,
  type ActionResult,
  type DomainEvent,
  type NewDomainEvent,
} from "@mamachi/protocol";
import { migrateStorage } from "./storage-schema.ts";
import { SensitiveFieldCodec, type SensitiveFieldKey } from "./sensitive-field-codec.ts";

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

export interface EventStoreOptions {
  encryptionKey?: SensitiveFieldKey;
}

export class EventStore {
  readonly #db: Database;
  readonly #codec: SensitiveFieldCodec;

  constructor(path = ":memory:", options: EventStoreOptions = {}) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#codec = new SensitiveFieldCodec(options.encryptionKey ?? null);
    if (path !== ":memory:") this.#db.run("PRAGMA journal_mode = WAL");
    migrateStorage(this.#db);
    this.#encryptLegacyPayloads();
    this.#migrateLegacyCodingSessions();
  }


  executeCommand(command: CommandRecord, decide: () => CommandDecision): CommandExecution {
    const transaction = this.#db.transaction((): CommandExecution => {
      const existing = this.#db
        .query<CommandRow, [string]>("SELECT result_json FROM commands WHERE id = ?")
        .get(command.id);
      if (existing) {
        return {
          result: parseActionResult(
            JSON.parse(this.#codec.decode(existing.result_json, `commands.result_json:${command.id}`)),
          ),
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
          this.#codec.encode(JSON.stringify(event.payload), `events.payload_json:${event.id}`),
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
          this.#codec.encode(JSON.stringify(command.payload), `commands.payload_json:${command.id}`),
          this.#codec.encode(JSON.stringify(decision.result), `commands.result_json:${command.id}`),
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
        payload: JSON.parse(this.#codec.decode(row.payload_json, `events.payload_json:${row.id}`)),
      }),
    );
  }

  eventCount(): number {
    const row = this.#db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get();
    return row?.count ?? 0;
  }
  #encryptLegacyPayloads(): void {
    if (!this.#codec.enabled) return;
    const transaction = this.#db.transaction(() => {
      const events = this.#db
        .query<{ id: string; payload_json: string }, []>("SELECT id, payload_json FROM events")
        .all();
      const updateEvent = this.#db.query("UPDATE events SET payload_json = ? WHERE id = ?");
      for (const row of events) {
        if (this.#codec.isEncrypted(row.payload_json)) continue;
        updateEvent.run(
          this.#codec.encode(row.payload_json, `events.payload_json:${row.id}`),
          row.id,
        );
      }

      const commands = this.#db
        .query<{ id: string; payload_json: string; result_json: string }, []>(
          "SELECT id, payload_json, result_json FROM commands",
        )
        .all();
      const updateCommand = this.#db.query(
        "UPDATE commands SET payload_json = ?, result_json = ? WHERE id = ?",
      );
      for (const row of commands) {
        const payload = this.#codec.isEncrypted(row.payload_json)
          ? row.payload_json
          : this.#codec.encode(row.payload_json, `commands.payload_json:${row.id}`);
        const result = this.#codec.isEncrypted(row.result_json)
          ? row.result_json
          : this.#codec.encode(row.result_json, `commands.result_json:${row.id}`);
        if (payload !== row.payload_json || result !== row.result_json) {
          updateCommand.run(payload, result, row.id);
        }
      }
    });
    transaction.immediate();
  }


  #migrateLegacyCodingSessions(): void {
    const rows = this.#db
      .query<{ id: string; payload_json: string }, []>(
        "SELECT id, payload_json FROM events WHERE type = 'coder.sessionBound'",
      )
      .all();
    if (rows.length === 0) return;

    const update = this.#db.query("UPDATE events SET payload_json = ? WHERE id = ?");
    const transaction = this.#db.transaction(() => {
      for (const row of rows) {
        const serialized = this.#codec.decode(
          row.payload_json,
          `events.payload_json:${row.id}`,
        );
        const payload: unknown = JSON.parse(serialized);
        if (
          typeof payload !== "object"
          || payload === null
          || Array.isArray(payload)
          || "backend" in payload
        ) {
          continue;
        }
        update.run(
          this.#codec.encode(
            JSON.stringify({ ...payload, backend: "omp" }),
            `events.payload_json:${row.id}`,
          ),
          row.id,
        );
      }
    });
    transaction.immediate();
  }

  close(): void {
    this.#db.close();
  }
}
