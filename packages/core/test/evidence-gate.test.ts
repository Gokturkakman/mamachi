import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifact-store.ts";
import { TaskController } from "../src/controller.ts";
import { EventStore } from "../src/event-store.ts";

const taskSpec = {
  repositoryId: "/tmp/mamachi-evidence-workspace",
  objective: "Implement and verify an observable behavior",
  acceptanceCriteria: ["The behavior is covered by a successful check"],
  constraints: ["Preserve existing user work"],
  attachmentIds: [],
  codingProfileId: "gpt-5.6-sol",
};

describe("structured completion evidence", () => {
  test("requires a successful verification after the latest file change", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-evidence-"));
    const databasePath = join(directory, "state.sqlite");
    const events = new EventStore(databasePath);
    const artifacts = new ArtifactStore(databasePath);
    try {
      const controller = new TaskController(events, {
        validateEvidence: (taskId, runId, evidenceIds) =>
          artifacts.validateCompletion(taskId, runId, evidenceIds),
      });
      const submitted = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: taskSpec,
      });
      if (submitted.status !== "accepted" || !submitted.taskId) throw new Error("Task submission failed");
      const taskId = submitted.taskId;
      const runId = controller.snapshot().tasks[0]?.activeRunId;
      if (!runId) throw new Error("Submitted task has no active run");

      const changed = artifacts.recordToolEvidence({
        taskId,
        runId,
        repository: taskSpec.repositoryId,
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/feature.ts", content: "export const enabled = true;" },
        result: { status: "ok" },
        isError: false,
      });
      expect(controller.recordArtifact(changed.id, taskId, changed).status).toBe("accepted");

      const premature = controller.completeTask(
        Bun.randomUUIDv7(),
        taskId,
        "Implemented the behavior",
        [changed.id],
      );
      expect(premature).toMatchObject({ status: "rejected", code: "verification_incomplete" });
      expect(controller.snapshot().tasks[0]?.state).toBe("running");

      const failedCheck = artifacts.recordToolEvidence({
        taskId,
        runId,
        repository: taskSpec.repositoryId,
        toolCallId: "test-1",
        toolName: "bash",
        input: { command: "bun test packages/core/test/feature.test.ts" },
        result: { exitCode: 1, stderr: "assertion failed" },
        isError: true,
      });
      expect(controller.recordArtifact(failedCheck.id, taskId, failedCheck).status).toBe("accepted");
      expect(
        controller.completeTask(Bun.randomUUIDv7(), taskId, "Tests still fail", [changed.id, failedCheck.id]),
      ).toMatchObject({ status: "rejected", code: "verification_incomplete" });

      const verified = artifacts.recordToolEvidence({
        taskId,
        runId,
        repository: taskSpec.repositoryId,
        toolCallId: "test-2",
        toolName: "bash",
        input: { command: "bun test packages/core/test/feature.test.ts" },
        result: { exitCode: 0, stdout: "1 pass" },
        isError: false,
      });
      expect(controller.recordArtifact(verified.id, taskId, verified).status).toBe("accepted");

      const completed = controller.completeTask(
        Bun.randomUUIDv7(),
        taskId,
        "Implemented and verified the behavior",
        [changed.id, failedCheck.id, verified.id],
      );
      expect(completed.status).toBe("accepted");
      expect(controller.snapshot().tasks[0]).toMatchObject({
        state: "completed",
        evidenceIds: [changed.id, failedCheck.id, verified.id],
      });
    } finally {
      artifacts.close();
      events.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("requires verification after shell-attributed file generation", () => {
    const artifacts = new ArtifactStore();
    const taskId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    try {
      const generated = artifacts.recordToolEvidence({
        taskId,
        runId,
        repository: taskSpec.repositoryId,
        toolCallId: "generate-1",
        toolName: "bash",
        input: { command: "bun run generate" },
        result: { exitCode: 0 },
        isError: false,
        changedFiles: ["src/generated.ts"],
      });
      expect(generated).toMatchObject({
        kind: "file_change",
        payload: { changedFiles: ["src/generated.ts"] },
      });
      expect(artifacts.validateCompletion(taskId, runId, [generated.id])).toMatchObject({
        valid: false,
        verificationComplete: false,
      });

      const verified = artifacts.recordToolEvidence({
        taskId,
        runId,
        repository: taskSpec.repositoryId,
        toolCallId: "test-generated",
        toolName: "bash",
        input: { command: "bun test packages/core/test/generated.test.ts" },
        result: { exitCode: 0 },
        isError: false,
        changedFiles: [],
      });
      expect(artifacts.validateCompletion(taskId, runId, [generated.id, verified.id])).toMatchObject({
        valid: true,
        verificationComplete: true,
      });
    } finally {
      artifacts.close();
    }
  });

  test("rejects evidence copied from another run", () => {
    const artifacts = new ArtifactStore();
    try {
      const evidence = artifacts.recordToolEvidence({
        taskId: Bun.randomUUIDv7(),
        runId: Bun.randomUUIDv7(),
        repository: taskSpec.repositoryId,
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "src/feature.ts" },
        result: { text: "source" },
        isError: false,
      });
      const validation = artifacts.validateCompletion(Bun.randomUUIDv7(), Bun.randomUUIDv7(), [evidence.id]);

      expect(validation).toMatchObject({
        valid: false,
        implementationComplete: false,
        verificationComplete: false,
      });
    } finally {
      artifacts.close();
    }
  });

  test("never persists credential-sensitive arguments or results", () => {
    const artifacts = new ArtifactStore();
    try {
      const secret = "sk-example-secret";
      const evidence = artifacts.recordToolEvidence({
        taskId: Bun.randomUUIDv7(),
        runId: Bun.randomUUIDv7(),
        repository: taskSpec.repositoryId,
        toolCallId: "bash-secret",
        toolName: "bash",
        input: { command: "printenv OPENAI_API_KEY" },
        result: { stdout: secret },
        isError: false,
      });

      expect(evidence.summary).not.toContain("OPENAI_API_KEY");
      expect(JSON.stringify(evidence.payload)).not.toContain(secret);
      expect(evidence.payload["resultExcerpt"]).toBe("[credential-sensitive result omitted]");
    } finally {
      artifacts.close();
    }
  });
});
