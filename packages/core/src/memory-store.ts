import { Database } from "bun:sqlite";
import { SensitiveFieldCodec, type SensitiveFieldKey } from "./sensitive-field-codec.ts";
import { migrateStorage } from "./storage-schema.ts";

export type MemoryScope = "global" | "project";

export interface MemoryFact {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  fact: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  project_id: string | null;
  content_ciphertext: string;
  created_at: string;
  updated_at: string;
}

export class MemoryStore {
  readonly #db: Database;
  readonly #codec: SensitiveFieldCodec;

  constructor(databasePath: string, encryptionKey: SensitiveFieldKey = null) {
    this.#db = new Database(databasePath);
    migrateStorage(this.#db);
    this.#codec = new SensitiveFieldCodec(encryptionKey);
    this.#encryptLegacyMemories();
  }

  remember(scope: MemoryScope, projectId: string | null, fact: string): MemoryFact {
    const normalized = fact.trim();
    if (!normalized) throw new Error("fact must be a non-empty string");
    if ((scope === "global" && projectId !== null) || (scope === "project" && !projectId)) {
      throw new Error("global memories require projectId null; project memories require a projectId");
    }
    if (projectId) this.#ensureProject(projectId);
    const id = Bun.randomUUIDv7();
    const now = new Date().toISOString();
    this.#db.query(
      `INSERT INTO memories(id, project_id, task_id, kind, content_ciphertext, created_at, updated_at)
       VALUES (?, ?, NULL, 'explicit_memory', ?, ?, ?)`,
    ).run(id, projectId, this.#codec.encode(normalized, `memories.content_ciphertext:${id}`), now, now);
    return { id, scope, projectId, fact: normalized, createdAt: now, updatedAt: now };
  }

  get(memoryId: string): MemoryFact | null {
    const row = this.#db.query<MemoryRow, [string]>(
      `SELECT id, project_id, content_ciphertext, created_at, updated_at
       FROM memories WHERE id = ? AND kind = 'explicit_memory'`,
    ).get(memoryId);
    return row ? this.#fromRow(row) : null;
  }

  list(projectId: string | null): MemoryFact[] {
    const rows = projectId === null
      ? this.#db.query<MemoryRow, []>(
          `SELECT id, project_id, content_ciphertext, created_at, updated_at
           FROM memories WHERE kind = 'explicit_memory' AND project_id IS NULL ORDER BY updated_at DESC`,
        ).all()
      : this.#db.query<MemoryRow, [string]>(
          `SELECT id, project_id, content_ciphertext, created_at, updated_at
           FROM memories WHERE kind = 'explicit_memory' AND (project_id IS NULL OR project_id = ?) ORDER BY updated_at DESC`,
        ).all(projectId);
    return rows.map((row) => this.#fromRow(row));
  }

  forget(memoryId: string, currentProjectId: string): boolean {
    const memory = this.get(memoryId);
    if (!memory || (memory.projectId !== null && memory.projectId !== currentProjectId)) return false;
    return this.#db.query("DELETE FROM memories WHERE id = ? AND kind = 'explicit_memory'").run(memoryId).changes === 1;
  }

  #encryptLegacyMemories(): void {
    if (!this.#codec.enabled) return;
    const rows = this.#db
      .query<{ id: string; content_ciphertext: string }, []>(
        "SELECT id, content_ciphertext FROM memories",
      )
      .all();
    const update = this.#db.query("UPDATE memories SET content_ciphertext = ? WHERE id = ?");
    const transaction = this.#db.transaction(() => {
      for (const row of rows) {
        if (this.#codec.isEncrypted(row.content_ciphertext)) continue;
        update.run(
          this.#codec.encode(row.content_ciphertext, `memories.content_ciphertext:${row.id}`),
          row.id,
        );
      }
    });
    transaction.immediate();
  }

  close(): void {
    this.#db.close();
  }

  #ensureProject(projectId: string): void {
    const now = new Date().toISOString();
    this.#db.query(
      `INSERT INTO projects(id, workspace_identity, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(projectId, projectId, projectId, now, now);
  }

  #fromRow(row: MemoryRow): MemoryFact {
    return {
      id: row.id,
      scope: row.project_id === null ? "global" : "project",
      projectId: row.project_id,
      fact: this.#codec.decode(row.content_ciphertext, `memories.content_ciphertext:${row.id}`),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
