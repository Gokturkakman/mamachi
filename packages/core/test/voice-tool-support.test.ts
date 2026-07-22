import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorContextRequestBroker } from "../src/editor-context-request.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { VoiceBriefStore, type VoiceBrief } from "../src/voice-brief-store.ts";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "mamachi-voice-tools-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("voice tool support stores", () => {
  test("persists scoped memories and validates scope before forgetting", () => {
    const path = temporaryDatabase();
    const key = Buffer.alloc(32, 7);
    const first = new MemoryStore(path, key);
    const global = first.remember("global", null, "Use concise commit messages");
    const project = first.remember("project", "/workspace/one", "Tests use Bun");
    first.close();

    const reopened = new MemoryStore(path, key);
    expect(reopened.list("/workspace/one").map((memory) => memory.id)).toEqual([project.id, global.id]);
    expect(reopened.forget(project.id, "/workspace/two")).toBe(false);
    expect(reopened.get(project.id)?.fact).toBe("Tests use Bun");
    expect(reopened.forget(project.id, "/workspace/one")).toBe(true);
    expect(reopened.forget(global.id, "/workspace/two")).toBe(true);
    expect(reopened.list("/workspace/one")).toEqual([]);
    reopened.close();

    const db = new Database(path);
    const stored = db.query<{ content_ciphertext: string }, []>("SELECT content_ciphertext FROM memories").all();
    expect(stored.every((row) => !row.content_ciphertext.includes("Tests use Bun"))).toBe(true);
    db.close();
  });

  test("restores a queued sleep brief after restart and delivers it only once", () => {
    const path = temporaryDatabase();
    const brief: VoiceBrief = {
      taskId: "task-1",
      kind: "completed",
      summary: "All focused checks passed",
      queuedAt: "2026-07-23T00:00:00.000Z",
      notification: { title: "Coding task finished", body: "All focused checks passed", kind: "completion" },
    };
    const first = new VoiceBriefStore(path);
    first.save(brief);
    first.close();

    const restarted = new VoiceBriefStore(path);
    expect(restarted.pending()).toEqual([brief]);
    restarted.markDelivered([brief.taskId]);
    expect(restarted.pending()).toEqual([]);
    restarted.close();

    const restartedAgain = new VoiceBriefStore(path);
    expect(restartedAgain.pending()).toEqual([]);
    restartedAgain.close();
  });
});

describe("EditorContextRequestBroker", () => {
  test("correlates a requested client response and rejects stale or mismatched responses", async () => {
    const broker = new EditorContextRequestBroker(100);
    let requestId = "";
    const pending = broker.request(["selection"], ["client-a"], (_clientId, id) => {
      requestId = id;
    });
    expect(broker.respond("client-b", requestId, {
      captures: [{ kind: "selection", payload: { selection: "secret" } }],
      errors: [],
    })).toBe(false);
    expect(broker.respond("client-a", requestId, {
      captures: [{ kind: "active_file", payload: {} }],
      errors: [],
    })).toBe(false);
    expect(broker.respond("client-a", requestId, {
      captures: [{ kind: "selection", payload: { selection: "explicit" } }],
      errors: [],
    })).toBe(true);
    expect(await pending).toEqual({
      captures: [{ kind: "selection", payload: { selection: "explicit" } }],
      errors: [],
    });
    expect(broker.respond("client-a", requestId, { captures: [], errors: [] })).toBe(false);
  });

  test("times out bounded requests and truthfully rejects when no client is connected", async () => {
    const broker = new EditorContextRequestBroker(5);
    await expect(broker.request(["diagnostics"], [], () => {})).rejects.toThrow("No connected VS Code client");
    await expect(broker.request(["diagnostics"], ["client-a"], () => {})).rejects.toThrow(
      "Timed out waiting for VS Code editor context",
    );
  });
});
