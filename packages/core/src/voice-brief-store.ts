import { Database } from "bun:sqlite";
import { SensitiveFieldCodec, type SensitiveFieldKey } from "./sensitive-field-codec.ts";

export type VoiceBriefKind = "completed" | "failed" | "awaiting_user";

export interface VoiceBrief {
  taskId: string;
  kind: VoiceBriefKind;
  summary: string;
  queuedAt: string;
  notification: {
    title: string;
    body: string;
    kind: "completion" | "failure" | "attention";
  };
}

interface BriefRow {
  task_id: string;
  kind: VoiceBriefKind;
  summary_ciphertext: string;
  notification_ciphertext: string;
  queued_at: string;
}

export class VoiceBriefStore {
  readonly #db: Database;
  readonly #codec: SensitiveFieldCodec;

  constructor(databasePath: string, encryptionKey: SensitiveFieldKey = null) {
    this.#db = new Database(databasePath);
    this.#codec = new SensitiveFieldCodec(encryptionKey);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS voice_briefs (
        task_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('completed', 'failed', 'awaiting_user')),
        summary_ciphertext TEXT NOT NULL,
        notification_ciphertext TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS voice_briefs_pending ON voice_briefs(delivered_at, queued_at);
    `);
  }

  save(brief: VoiceBrief): void {
    this.#db.query(
      `INSERT INTO voice_briefs(task_id, kind, summary_ciphertext, notification_ciphertext, queued_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(task_id) DO UPDATE SET
         kind = excluded.kind,
         summary_ciphertext = excluded.summary_ciphertext,
         notification_ciphertext = excluded.notification_ciphertext,
         queued_at = excluded.queued_at,
         delivered_at = NULL`,
    ).run(
      brief.taskId,
      brief.kind,
      this.#codec.encode(brief.summary, `voice_briefs.summary:${brief.taskId}`),
      this.#codec.encode(JSON.stringify(brief.notification), `voice_briefs.notification:${brief.taskId}`),
      brief.queuedAt,
    );
  }

  pending(): VoiceBrief[] {
    return this.#db.query<BriefRow, []>(
      `SELECT task_id, kind, summary_ciphertext, notification_ciphertext, queued_at
       FROM voice_briefs WHERE delivered_at IS NULL ORDER BY queued_at`,
    ).all().map((row) => ({
      taskId: row.task_id,
      kind: row.kind,
      summary: this.#codec.decode(row.summary_ciphertext, `voice_briefs.summary:${row.task_id}`),
      notification: JSON.parse(
        this.#codec.decode(row.notification_ciphertext, `voice_briefs.notification:${row.task_id}`),
      ) as VoiceBrief["notification"],
      queuedAt: row.queued_at,
    }));
  }

  markDelivered(taskIds: readonly string[]): void {
    const update = this.#db.query("UPDATE voice_briefs SET delivered_at = ? WHERE task_id = ? AND delivered_at IS NULL");
    const now = new Date().toISOString();
    this.#db.transaction(() => {
      for (const taskId of new Set(taskIds)) update.run(now, taskId);
    })();
  }

  close(): void {
    this.#db.close();
  }
}
