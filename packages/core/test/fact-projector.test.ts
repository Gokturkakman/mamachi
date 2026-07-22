import { describe, expect, test } from "bun:test";
import { ArtifactStore, type ToolEvidenceInput } from "../src/artifact-store.ts";
import { TaskController } from "../src/controller.ts";
import { EventStore } from "../src/event-store.ts";
import { FactProjector } from "../src/fact-projector.ts";

const repository = "/tmp/mamachi-fact-projector";

describe("FactProjector", () => {
  test("derives exact phase, files, and verification separately from observer interpretation", () => {
    const events = new EventStore();
    const artifacts = new ArtifactStore();
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
        payload: {
          repositoryId: repository,
          objective: "Change and verify behavior",
          acceptanceCriteria: ["The check passes"],
          constraints: [],
          attachmentIds: [],
          codingProfileId: null,
        },
      });
      if (submitted.status !== "accepted" || !submitted.taskId) throw new Error("Task submission failed");
      const taskId = submitted.taskId;
      const runId = controller.snapshot().tasks[0]?.activeRunId;
      if (!runId) throw new Error("Task has no active run");
      const projector = new FactProjector(artifacts);
      const evidenceIds: string[] = [];
      const record = (input: Omit<ToolEvidenceInput, "taskId" | "runId" | "repository">): void => {
        const artifact = artifacts.recordToolEvidence({ taskId, runId, repository, ...input });
        evidenceIds.push(artifact.id);
        const result = controller.recordArtifact(artifact.id, taskId, artifact);
        if (result.status !== "accepted") throw new Error("Artifact projection failed");
      };

      expect(projector.project(controller.snapshot()).activeTask).toMatchObject({
        phase: "understanding",
        progress: 15,
        implementationState: "pending",
        verificationState: "not_required",
      });

      record({
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "src/feature.ts" },
        result: { text: "source" },
        isError: false,
      });
      expect(projector.project(controller.snapshot()).activeTask).toMatchObject({
        phase: "execution",
        progress: 35,
        implementationState: "observed",
      });

      record({
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/feature.ts", content: "export const enabled = true;" },
        result: { status: "ok" },
        isError: false,
      });
      expect(projector.project(controller.snapshot()).activeTask).toMatchObject({
        phase: "implementation",
        progress: 65,
        changedFiles: ["src/feature.ts"],
        verificationState: "pending",
      });

      record({
        toolCallId: "test-1",
        toolName: "bash",
        input: { command: "bun test src/feature.test.ts" },
        result: { exitCode: 1 },
        isError: true,
      });
      expect(projector.project(controller.snapshot()).activeTask).toMatchObject({
        phase: "verification",
        progress: 75,
        currentStep: "Fixing a failed verification",
        verificationState: "failed",
      });

      record({
        toolCallId: "test-2",
        toolName: "bash",
        input: { command: "bun test src/feature.test.ts" },
        result: { exitCode: 0, stdout: "1 pass" },
        isError: false,
      });
      artifacts.recordObserverInterpretation({
        taskId,
        runId,
        summary: "The change might still be risky.",
        risks: ["Interpretation only"],
        nextStep: "Review the evidence",
        model: "observer/mock",
      });
      const verifiedFacts = projector.project(controller.snapshot()).activeTask;
      expect(verifiedFacts).toMatchObject({
        phase: "verification",
        progress: 90,
        verificationState: "passed",
        observerInterpretation: {
          summary: "The change might still be risky.",
          model: "observer/mock",
        },
      });

      const completion = controller.completeTask(
        Bun.randomUUIDv7(),
        taskId,
        "Behavior changed and verification passed",
        evidenceIds,
      );
      expect(completion.status).toBe("accepted");
      expect(projector.project(controller.snapshot()).tasks[0]).toMatchObject({
        phase: "complete",
        progress: 100,
        implementationState: "complete",
        verificationState: "passed",
        changedFiles: ["src/feature.ts"],
      });
    } finally {
      artifacts.close();
      events.close();
    }
  });
});
