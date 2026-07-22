import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifact-store.ts";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "mamachi-artifact-encryption-"));
  temporaryDirectories.push(directory);
  return join(directory, "artifacts.sqlite");
}

function testKey(): string {
  return Buffer.alloc(32, 0x5a).toString("base64");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("artifact payload encryption", () => {
  test("encrypts sensitive fields at rest and transparently round-trips them", () => {
    const path = temporaryDatabase();
    const secret = "known-secret-7b19c3f0";
    const store = new ArtifactStore(path, { encryptionKey: testKey() });

    const context = store.capture("selection", "/tmp/project", `selected ${secret}`, {
      text: secret,
    });
    const evidence = store.recordToolEvidence({
      taskId: "task-1",
      runId: "run-1",
      repository: "/tmp/project",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: `src/${secret}.ts` },
      result: { contents: secret },
      isError: false,
    });
    const interpretation = store.recordObserverInterpretation({
      taskId: "task-1",
      runId: "run-1",
      summary: `summary ${secret}`,
      risks: [`risk ${secret}`],
      nextStep: `next ${secret}`,
      model: "observer-test",
    });

    expect(store.get([context.id])[0]).toMatchObject({ summary: `selected ${secret}`, payload: { text: secret } });
    expect(store.getEvidence([evidence.id])[0]).toMatchObject({
      summary: `read: src/${secret}.ts`,
    });
    expect(store.getEvidence([evidence.id])[0]?.payload["resultExcerpt"]).toContain(secret);
    expect(store.latestObserverInterpretation("task-1")).toEqual(interpretation);
    store.close();

    const db = new Database(path, { strict: true });
    const contextRow = db
      .query<{ summary: string; payload_json: string }, []>("SELECT summary, payload_json FROM context_artifacts")
      .get()!;
    const evidenceRow = db
      .query<{ summary: string; payload_json: string }, []>("SELECT summary, payload_json FROM artifacts")
      .get()!;
    const observer = db
      .query<{ summary: string; risks_json: string; next_step: string }, []>(
        "SELECT summary, risks_json, next_step FROM observer_interpretations",
      )
      .get()!;
    db.close();

    for (const stored of [
      contextRow.summary,
      contextRow.payload_json,
      evidenceRow.summary,
      evidenceRow.payload_json,
      observer.summary,
      observer.risks_json,
      observer.next_step,
    ]) {
      expect(stored).toStartWith("mamachi:aes256gcm:v1:");
      expect(stored).not.toContain(secret);
    }
    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  });

  test("migrates and reads legacy plaintext artifact and observer rows when encryption is enabled", () => {
    const path = temporaryDatabase();
    new ArtifactStore(path, { encryptionKey: null }).close();

    const db = new Database(path, { strict: true });
    db.query(
      `INSERT INTO context_artifacts (id, kind, workspace, summary, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("legacy-context", "active_file", "/tmp/project", "legacy", '{"text":"legacy context"}', "2025-01-01T00:00:00.000Z");
    db.query(
      `INSERT INTO artifacts (
         id, task_id, run_id, tool_call_id, tool_name, kind, summary, successful, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-evidence",
      "task-legacy",
      "run-legacy",
      "call-legacy",
      "read",
      "tool_result",
      "legacy",
      1,
      '{"resultExcerpt":"legacy evidence"}',
      "2025-01-01T00:00:00.000Z",
    );
    db.query(
      `INSERT INTO observer_interpretations (
         id, task_id, run_id, summary, risks_json, next_step, model, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-observer",
      "task-legacy",
      "run-legacy",
      "legacy observer",
      '["legacy risk"]',
      "legacy next",
      "observer-test",
      "2025-01-01T00:00:00.000Z",
    );
    db.close();

    const store = new ArtifactStore(path, { encryptionKey: testKey() });
    expect(store.get(["legacy-context"])[0]?.payload).toEqual({ text: "legacy context" });
    expect(store.getEvidence(["legacy-evidence"])[0]?.payload).toEqual({ resultExcerpt: "legacy evidence" });
    expect(store.latestObserverInterpretation("task-legacy")).toMatchObject({
      summary: "legacy observer",
      risks: ["legacy risk"],
      nextStep: "legacy next",
    });
    store.close();

    const migrated = new Database(path, { strict: true });
    const encryptedFields = [
      ...Object.values(
        migrated
          .query<{ summary: string; payload_json: string }, []>(
            "SELECT summary, payload_json FROM context_artifacts WHERE id = 'legacy-context'",
          )
          .get()!,
      ),
      ...Object.values(
        migrated
          .query<{ summary: string; payload_json: string }, []>(
            "SELECT summary, payload_json FROM artifacts WHERE id = 'legacy-evidence'",
          )
          .get()!,
      ),
      ...Object.values(
        migrated
          .query<{ summary: string; risks_json: string; next_step: string }, []>(
            "SELECT summary, risks_json, next_step FROM observer_interpretations WHERE id = 'legacy-observer'",
          )
          .get()!,
      ),
    ];
    expect(encryptedFields.every((value) => value.startsWith("mamachi:aes256gcm:v1:"))).toBe(true);
    migrated.close();
  });

  test("fails closed for tampered ciphertext and malformed explicit keys", () => {
    const path = temporaryDatabase();
    const store = new ArtifactStore(path, { encryptionKey: testKey() });
    const context = store.capture("diagnostics", "/tmp/project", "diagnostics", { secret: "tamper-me" });
    store.close();

    const db = new Database(path, { strict: true });
    const stored = db
      .query<{ payload_json: string }, [string]>("SELECT payload_json FROM context_artifacts WHERE id = ?")
      .get(context.id)!.payload_json;
    const ciphertextStart = stored.lastIndexOf(".") + 1;
    const replacement = stored[ciphertextStart] === "A" ? "B" : "A";
    const tampered = `${stored.slice(0, ciphertextStart)}${replacement}${stored.slice(ciphertextStart + 1)}`;
    db.query("UPDATE context_artifacts SET payload_json = ? WHERE id = ?").run(tampered, context.id);
    db.close();

    const reopened = new ArtifactStore(path, { encryptionKey: testKey() });
    expect(() => reopened.get([context.id])).toThrow("Encrypted artifact payload authentication failed");
    reopened.close();

    expect(
      () => new ArtifactStore(temporaryDatabase(), { encryptionKey: Buffer.from("too short").toString("base64") }),
    ).toThrow("MAMACHI_ENCRYPTION_KEY must decode to exactly 32 bytes");
    expect(() => new ArtifactStore(temporaryDatabase(), { encryptionKey: "not base64" })).toThrow(
      "MAMACHI_ENCRYPTION_KEY is not valid base64",
    );
  });

  test("keeps plaintext development storage compatible when no key is configured", () => {
    const path = temporaryDatabase();
    const store = new ArtifactStore(path, { encryptionKey: null });
    const context = store.capture("active_file", "/tmp/project", "active file", { path: "src/index.ts" });
    expect(store.get([context.id])[0]).toMatchObject({
      summary: "active file",
      payload: { path: "src/index.ts" },
    });
    store.close();

    const db = new Database(path, { strict: true });
    expect(
      db.query<{ summary: string; payload_json: string }, []>(
        "SELECT summary, payload_json FROM context_artifacts",
      ).get(),
    ).toEqual({ summary: "active file", payload_json: '{"path":"src/index.ts"}' });
    db.close();
  });
});
