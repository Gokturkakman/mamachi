import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGuard, extractToolPaths } from "../src/workspace-guard.ts";

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "mamachi-guard-"));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], { stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q");
  writeFileSync(join(repository, "feature.ts"), "export const value = 1;\n");
  git("add", "feature.ts");
  git("-c", "user.name=Mamachi Test", "-c", "user.email=test@mamachi.local", "commit", "-qm", "baseline");
  return repository;
}

describe("WorkspaceGuard", () => {
  test("extracts hashline edit targets without receiving file content separately", () => {
    expect(
      extractToolPaths({
        patch: "*** Begin Patch\n[feature.ts#ABCD]\nSWAP 1.=1:\n+export const value = 2;\n*** End Patch\n",
      }),
    ).toEqual(["feature.ts"]);
  });

  test("blocks stale writes, then attributes only reconciled coder mutations", async () => {
    const repository = createRepository();
    try {
      const guard = new WorkspaceGuard();
      await guard.start(Bun.randomUUIDv7(), Bun.randomUUIDv7(), repository);
      writeFileSync(join(repository, "feature.ts"), "export const value = 2;\n");

      const stale = await guard.beforeTool("edit-stale", "edit", {
        path: "feature.ts",
        patch: "replace value",
      });
      expect(stale).toMatchObject({
        status: "conflict",
        conflict: { paths: ["feature.ts"] },
      });

      expect(await guard.reconcile()).toEqual(["feature.ts"]);
      expect(await guard.beforeTool("edit-safe", "edit", { path: "feature.ts" })).toEqual({ status: "allowed" });
      writeFileSync(join(repository, "feature.ts"), "export const value = 3;\n");
      expect(await guard.afterTool("edit-safe")).toBeNull();
      expect(guard.mutations()).toMatchObject([
        { toolCallId: "edit-safe", toolName: "edit", paths: ["feature.ts"] },
      ]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("protects dirty editor buffers and detects edits during a tool call", async () => {
    const repository = createRepository();
    try {
      const guard = new WorkspaceGuard();
      guard.updateEditorState({
        workspace: repository,
        path: join(repository, "feature.ts"),
        version: 2,
        dirty: true,
        open: true,
      });
      await guard.start(Bun.randomUUIDv7(), Bun.randomUUIDv7(), repository);
      expect(await guard.beforeTool("read-dirty", "read", { path: "feature.ts" })).toEqual({ status: "allowed" });
      expect(await guard.afterTool("read-dirty")).toBeNull();

      const dirty = await guard.beforeTool("write-dirty", "write", {
        path: "feature.ts",
        content: "replacement",
      });
      expect(dirty).toMatchObject({
        status: "conflict",
        conflict: { paths: ["feature.ts"], dirtyFiles: ["feature.ts"] },
      });

      guard.updateEditorState({
        workspace: repository,
        path: join(repository, "feature.ts"),
        version: 3,
        dirty: false,
        open: true,
      });
      await guard.reconcile();
      expect(await guard.beforeTool("edit-race", "edit", { path: "feature.ts" })).toEqual({ status: "allowed" });
      guard.updateEditorState({
        workspace: repository,
        path: join(repository, "feature.ts"),
        version: 4,
        dirty: true,
        open: true,
      });
      writeFileSync(join(repository, "feature.ts"), "export const value = 4;\n");

      expect(await guard.afterTool("edit-race")).toMatchObject({
        paths: ["feature.ts"],
        reason: "The user edited a target while the coding tool was running",
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("blocks whole-file replacement of pre-existing user changes but permits anchored edits", async () => {
    const repository = createRepository();
    try {
      writeFileSync(join(repository, "feature.ts"), "export const userChange = true;\n");
      const guard = new WorkspaceGuard();
      await guard.start(Bun.randomUUIDv7(), Bun.randomUUIDv7(), repository);

      expect(await guard.beforeTool("write-preexisting", "write", { path: "feature.ts", content: "replacement" }))
        .toMatchObject({ status: "conflict", conflict: { paths: ["feature.ts"] } });
      expect(await guard.beforeTool("edit-preexisting", "edit", { path: "feature.ts", patch: "anchored" }))
        .toEqual({ status: "allowed" });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("blocks broad shell mutations when any user-owned change is present", async () => {
    const repository = createRepository();
    try {
      writeFileSync(join(repository, "feature.ts"), "export const userChange = true;\n");
      const guard = new WorkspaceGuard();
      await guard.start(Bun.randomUUIDv7(), Bun.randomUUIDv7(), repository);

      const decision = await guard.beforeTool("bash-1", "bash", { command: "rm -f generated.txt" });
      expect(decision).toMatchObject({
        status: "conflict",
        conflict: {
          reason: "A broad mutating command may overlap user changes",
          paths: ["feature.ts"],
        },
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
  test("attributes filesystem changes made by shell commands without mutation keywords", async () => {
    const repository = createRepository();
    try {
      const guard = new WorkspaceGuard();
      await guard.start(Bun.randomUUIDv7(), Bun.randomUUIDv7(), repository);

      expect(await guard.beforeTool("bash-generate", "bash", { command: "bun run generate" })).toEqual({
        status: "allowed",
      });
      writeFileSync(join(repository, "generated.ts"), "export const generated = true;\n");
      expect(await guard.afterTool("bash-generate")).toBeNull();
      expect(guard.mutations()).toMatchObject([
        { toolCallId: "bash-generate", toolName: "bash", paths: ["generated.ts"] },
      ]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

});
