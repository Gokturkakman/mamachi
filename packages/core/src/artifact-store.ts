import { Database } from "bun:sqlite";

export type ContextKind = "active_file" | "selection" | "diagnostics" | "terminal_excerpt";

export interface CapturedContext {
  id: string;
  kind: ContextKind;
  workspace: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ArtifactRow {
  id: string;
  kind: ContextKind;
  workspace: string;
  summary: string;
  payload_json: string;
  created_at: string;
}

export class ArtifactStore {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true });
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS context_artifacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  capture(kind: ContextKind, workspace: string, summary: string, payload: Record<string, unknown>): CapturedContext {
    const id = Bun.randomUUIDv7();
    const createdAt = new Date().toISOString();
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, "utf8") > 131_072) {
      throw new Error("Captured editor context exceeds the 128 KiB limit");
    }
    this.#db
      .query(
        `INSERT INTO context_artifacts (id, kind, workspace, summary, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, kind, workspace, summary, payloadJson, createdAt);
    return { id, kind, workspace, summary, payload, createdAt };
  }

  get(ids: readonly string[]): CapturedContext[] {
    if (ids.length === 0) return [];
    const query = this.#db.query<ArtifactRow, [string]>(
      "SELECT id, kind, workspace, summary, payload_json, created_at FROM context_artifacts WHERE id = ?",
    );
    const byId = new Map<string, CapturedContext>();
    for (const id of ids) {
      const row = query.get(id);
      if (!row) continue;
      byId.set(id, {
        id: row.id,
        kind: row.kind,
        workspace: row.workspace,
        summary: row.summary,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        createdAt: row.created_at,
      });
    }
    return ids.flatMap((id) => {
      const artifact = byId.get(id);
      return artifact ? [artifact] : [];
    });
  }

  close(): void {
    this.#db.close();
  }
}
