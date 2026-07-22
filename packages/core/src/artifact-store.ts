import { Database } from "bun:sqlite";
import { SensitiveFieldCodec, type SensitiveFieldKey } from "./sensitive-field-codec.ts";
import { assessToolCall, type PolicyCategory } from "./policy.ts";
import { extractToolPaths } from "./workspace-guard.ts";
import { migrateStorage } from "./storage-schema.ts";

export type ContextKind = "active_file" | "selection" | "diagnostics" | "terminal_excerpt";

export interface CapturedContext {
  id: string;
  kind: ContextKind;
  workspace: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type EvidenceKind = "tool_result" | "file_change" | "verification";

export interface EvidenceArtifact {
  id: string;
  ordinal: number;
  taskId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  kind: EvidenceKind;
  summary: string;
  successful: boolean;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ToolEvidenceInput {
  taskId: string;
  runId: string;
  repository: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  changedFiles?: string[];
}

export interface CompletionEvidenceValidation {
  valid: boolean;
  implementationComplete: boolean;
  verificationComplete: boolean;
  explanation: string;
}

export interface ObserverInterpretation {
  id: string;
  taskId: string;
  runId: string;
  summary: string;
  risks: string[];
  nextStep: string | null;
  model: string;
  createdAt: string;
}

export interface ObserverInterpretationInput {
  taskId: string;
  runId: string;
  summary: string;
  risks: string[];
  nextStep: string | null;
  model: string;
}

export interface ArtifactStoreOptions {
  encryptionKey?: SensitiveFieldKey;
}

interface ObserverRow {
  id: string;
  task_id: string;
  run_id: string;
  summary: string;
  risks_json: string;
  next_step: string | null;
  model: string;
  created_at: string;
}

interface EvidenceRow {
  ordinal: number;
  id: string;
  task_id: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  kind: EvidenceKind;
  summary: string;
  successful: number;
  payload_json: string;
  created_at: string;
}

const verificationCommandPattern =
  /(?:^|\s)(?:test|tests|typecheck|check|build|lint|verify)(?:\s|$)|\b(?:pytest|swift\s+test|cargo\s+test|go\s+test|bun\s+test|npm\s+test|tsc\b)/i;

function safeResultExcerpt(result: unknown): string {
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(result, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    serialized = String(result);
  }
  return serialized.slice(0, 32_768);
}

function safeInputSummary(
  input: unknown,
  category: PolicyCategory,
): string {
  const details =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (category !== "routine") return `[${category} arguments omitted]`;
  if (typeof details["command"] === "string") return details["command"].slice(0, 1_000);
  if (typeof details["path"] === "string") return details["path"].slice(0, 1_000);
  return Object.keys(details).sort().join(", ").slice(0, 1_000) || "no arguments";
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
  readonly #codec: SensitiveFieldCodec;

  constructor(path = ":memory:", options: ArtifactStoreOptions = {}) {
    this.#codec =
      options.encryptionKey === undefined
        ? SensitiveFieldCodec.fromEnvironment()
        : new SensitiveFieldCodec(options.encryptionKey);
    this.#db = new Database(path, { create: true });
    migrateStorage(this.#db);
    this.#encryptLegacyFields();
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
      .run(
        id,
        kind,
        workspace,
        this.#codec.encode(summary, `context_artifacts.summary:${id}`),
        this.#codec.encode(payloadJson, `context_artifacts.payload_json:${id}`),
        createdAt,
      );
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
        summary: this.#codec.decode(row.summary, `context_artifacts.summary:${row.id}`),
        payload: JSON.parse(
          this.#codec.decode(row.payload_json, `context_artifacts.payload_json:${row.id}`),
        ) as Record<string, unknown>,
        createdAt: row.created_at,
      });
    }
    return ids.flatMap((id) => {
      const artifact = byId.get(id);
      return artifact ? [artifact] : [];
    });
  }

  recordToolEvidence(input: ToolEvidenceInput): EvidenceArtifact {
    const details =
      typeof input.input === "object" && input.input !== null && !Array.isArray(input.input)
        ? (input.input as Record<string, unknown>)
        : {};
    const command = typeof details["command"] === "string" ? details["command"] : "";
    const assessment = assessToolCall(input.toolName, input.input, input.repository);
    const attributedChanges = input.changedFiles?.filter(
      (path, index, paths) => path.length > 0 && paths.indexOf(path) === index,
    );
    const lspMutation =
      input.toolName === "lsp" &&
      details["apply"] === true &&
      ["rename", "rename_file", "code_actions"].includes(String(details["action"]));
    const declaredMutation = ["edit", "write", "ast_edit"].includes(input.toolName) || lspMutation;
    const changedFiles = attributedChanges ?? (declaredMutation ? extractToolPaths(input.input) : []);
    const kind: EvidenceKind =
      changedFiles.length > 0
        ? "file_change"
        : input.toolName === "bash" && verificationCommandPattern.test(command)
          ? "verification"
          : "tool_result";
    const successful = !input.isError;
    const inputSummary = safeInputSummary(input.input, assessment.category);
    const summary = `${input.toolName}: ${inputSummary}`;
    const payload = {
      inputSummary,
      changedFiles,
      resultExcerpt:
        assessment.category === "credential_access"
          ? "[credential-sensitive result omitted]"
          : safeResultExcerpt(input.result),
      isError: input.isError,
    };
    const id = Bun.randomUUIDv7();
    const createdAt = new Date().toISOString();
    const inserted = this.#db
      .query(
        `INSERT INTO artifacts(
          id, task_id, run_id, tool_call_id, tool_name, kind,
          summary, successful, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.runId,
        input.toolCallId,
        input.toolName,
        kind,
        this.#codec.encode(summary, `artifacts.summary:${id}`),
        successful ? 1 : 0,
        this.#codec.encode(JSON.stringify(payload), `artifacts.payload_json:${id}`),
        createdAt,
      );
    return {
      id,
      ordinal: Number(inserted.lastInsertRowid),
      taskId: input.taskId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      kind,
      summary,
      successful,
      payload,
      createdAt,
    };
  }

  getEvidence(ids: readonly string[]): EvidenceArtifact[] {
    if (ids.length === 0) return [];
    const query = this.#db.query<EvidenceRow, [string]>(
      `SELECT ordinal, id, task_id, run_id, tool_call_id, tool_name, kind,
              summary, successful, payload_json, created_at
       FROM artifacts WHERE id = ?`,
    );
    const artifacts: EvidenceArtifact[] = [];
    for (const id of ids) {
      const row = query.get(id);
      if (!row) continue;
      artifacts.push({
        id: row.id,
        ordinal: row.ordinal,
        taskId: row.task_id,
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        kind: row.kind,
        summary: this.#codec.decode(row.summary, `artifacts.summary:${row.id}`),
        successful: row.successful === 1,
        payload: JSON.parse(
          this.#codec.decode(row.payload_json, `artifacts.payload_json:${row.id}`),
        ) as Record<string, unknown>,
        createdAt: row.created_at,
      });
    }
    return artifacts;
  }

  validateCompletion(taskId: string, runId: string, evidenceIds: readonly string[]): CompletionEvidenceValidation {
    const uniqueIds = [...new Set(evidenceIds)];
    const evidence = this.getEvidence(uniqueIds);
    if (uniqueIds.length === 0 || evidence.length !== uniqueIds.length) {
      return {
        valid: false,
        implementationComplete: false,
        verificationComplete: false,
        explanation: "Completion requires valid, persisted evidence from this run",
      };
    }
    if (evidence.some((artifact) => artifact.taskId !== taskId || artifact.runId !== runId)) {
      return {
        valid: false,
        implementationComplete: false,
        verificationComplete: false,
        explanation: "Completion evidence belongs to a different task or run",
      };
    }
    const successful = evidence.filter((artifact) => artifact.successful);
    const fileChanges = successful.filter((artifact) => artifact.kind === "file_change");
    const lastFileChange = Math.max(0, ...fileChanges.map((artifact) => artifact.ordinal));
    const verificationComplete =
      fileChanges.length === 0 ||
      successful.some((artifact) => artifact.kind === "verification" && artifact.ordinal > lastFileChange);
    return {
      valid: successful.length > 0 && verificationComplete,
      implementationComplete: fileChanges.length > 0 || successful.length > 0,
      verificationComplete,
      explanation:
        successful.length === 0
          ? "All supplied evidence records failed"
          : verificationComplete
            ? "Implementation and verification evidence are grounded in persisted tool results"
            : "A successful verification command must run after the latest file change",
    };
  }

  listEvidenceForTask(taskId: string): EvidenceArtifact[] {
    const rows = this.#db
      .query<EvidenceRow, [string]>(
        `SELECT ordinal, id, task_id, run_id, tool_call_id, tool_name, kind,
                summary, successful, payload_json, created_at
         FROM artifacts WHERE task_id = ? ORDER BY ordinal`,
      )
      .all(taskId);
    return rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      taskId: row.task_id,
      runId: row.run_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      kind: row.kind,
      summary: this.#codec.decode(row.summary, `artifacts.summary:${row.id}`),
      successful: row.successful === 1,
      payload: JSON.parse(
        this.#codec.decode(row.payload_json, `artifacts.payload_json:${row.id}`),
      ) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  recordObserverInterpretation(input: ObserverInterpretationInput): ObserverInterpretation {
    const id = Bun.randomUUIDv7();
    const createdAt = new Date().toISOString();
    const summary = input.summary.trim().slice(0, 2_000);
    const risks = input.risks.map((risk) => risk.trim()).filter(Boolean).slice(0, 8);
    const nextStep = input.nextStep?.trim().slice(0, 1_000) || null;
    this.#db
      .query(
        `INSERT INTO observer_interpretations(
          id, task_id, run_id, summary, risks_json, next_step, model, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.runId,
        this.#codec.encode(summary, `observer_interpretations.summary:${id}`),
        this.#codec.encode(JSON.stringify(risks), `observer_interpretations.risks_json:${id}`),
        nextStep === null
          ? null
          : this.#codec.encode(nextStep, `observer_interpretations.next_step:${id}`),
        input.model,
        createdAt,
      );
    return {
      id,
      taskId: input.taskId,
      runId: input.runId,
      summary,
      risks,
      nextStep,
      model: input.model,
      createdAt,
    };
  }

  latestObserverInterpretation(taskId: string): ObserverInterpretation | null {
    const row = this.#db
      .query<ObserverRow, [string]>(
        `SELECT id, task_id, run_id, summary, risks_json, next_step, model, created_at
         FROM observer_interpretations WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(taskId);
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      summary: this.#codec.decode(row.summary, `observer_interpretations.summary:${row.id}`),
      risks: JSON.parse(
        this.#codec.decode(row.risks_json, `observer_interpretations.risks_json:${row.id}`),
      ) as string[],
      nextStep:
        row.next_step === null
          ? null
          : this.#codec.decode(row.next_step, `observer_interpretations.next_step:${row.id}`),
      model: row.model,
      createdAt: row.created_at,
    };
  }

  #encryptLegacyFields(): void {
    if (!this.#codec.enabled) return;
    const transaction = this.#db.transaction(() => {
      const contexts = this.#db
        .query<{ id: string; summary: string; payload_json: string }, []>(
          "SELECT id, summary, payload_json FROM context_artifacts",
        )
        .all();
      const updateContext = this.#db.query(
        "UPDATE context_artifacts SET summary = ?, payload_json = ? WHERE id = ?",
      );
      for (const row of contexts) {
        const summary = this.#codec.isEncrypted(row.summary)
          ? row.summary
          : this.#codec.encode(row.summary, `context_artifacts.summary:${row.id}`);
        const payload = this.#codec.isEncrypted(row.payload_json)
          ? row.payload_json
          : this.#codec.encode(row.payload_json, `context_artifacts.payload_json:${row.id}`);
        if (summary !== row.summary || payload !== row.payload_json) {
          updateContext.run(summary, payload, row.id);
        }
      }

      const evidence = this.#db
        .query<{ id: string; summary: string; payload_json: string }, []>(
          "SELECT id, summary, payload_json FROM artifacts",
        )
        .all();
      const updateEvidence = this.#db.query(
        "UPDATE artifacts SET summary = ?, payload_json = ? WHERE id = ?",
      );
      for (const row of evidence) {
        const summary = this.#codec.isEncrypted(row.summary)
          ? row.summary
          : this.#codec.encode(row.summary, `artifacts.summary:${row.id}`);
        const payload = this.#codec.isEncrypted(row.payload_json)
          ? row.payload_json
          : this.#codec.encode(row.payload_json, `artifacts.payload_json:${row.id}`);
        if (summary !== row.summary || payload !== row.payload_json) {
          updateEvidence.run(summary, payload, row.id);
        }
      }

      const interpretations = this.#db
        .query<{ id: string; summary: string; risks_json: string; next_step: string | null }, []>(
          "SELECT id, summary, risks_json, next_step FROM observer_interpretations",
        )
        .all();
      const updateInterpretation = this.#db.query(
        "UPDATE observer_interpretations SET summary = ?, risks_json = ?, next_step = ? WHERE id = ?",
      );
      for (const row of interpretations) {
        const summary = this.#codec.isEncrypted(row.summary)
          ? row.summary
          : this.#codec.encode(row.summary, `observer_interpretations.summary:${row.id}`);
        const risks = this.#codec.isEncrypted(row.risks_json)
          ? row.risks_json
          : this.#codec.encode(row.risks_json, `observer_interpretations.risks_json:${row.id}`);
        const nextStep =
          row.next_step === null || this.#codec.isEncrypted(row.next_step)
            ? row.next_step
            : this.#codec.encode(row.next_step, `observer_interpretations.next_step:${row.id}`);
        if (summary !== row.summary || risks !== row.risks_json || nextStep !== row.next_step) {
          updateInterpretation.run(summary, risks, nextStep, row.id);
        }
      }
    });
    transaction.immediate();
  }

  close(): void {
    this.#db.close();
  }
}
