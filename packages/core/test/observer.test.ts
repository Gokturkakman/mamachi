import { describe, expect, test } from "bun:test";
import { ArtifactStore } from "../src/artifact-store.ts";
import {
  PassiveObserver,
  type ObserverBackend,
  type ObserverPacket,
} from "../src/observer.ts";

const packet = (currentStep: string): ObserverPacket => ({
  taskId: "019f8b7a-0000-7000-8000-000000000001",
  runId: "019f8b7a-0000-7000-8000-000000000002",
  repository: "/tmp/mamachi-observer",
  objective: "Implement and verify a behavior",
  taskState: "running",
  terminalSummary: null,
  facts: {
    phase: "implementation",
    progress: 65,
    currentStep,
    implementationState: "changed",
    verificationState: "pending",
    changedFiles: ["src/feature.ts"],
    verificationSummaries: [],
    recentActivity: [],
  },
});

describe("PassiveObserver", () => {
  test("runs off the control path, coalesces updates, and persists interpretation separately", async () => {
    const artifacts = new ArtifactStore();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const backend: ObserverBackend = {
      model: "observer/mock-mini",
      observe: async (input) => {
        calls += 1;
        if (calls === 1) await firstGate;
        return {
          summary: `Observed: ${input.facts.currentStep}`,
          risks: input.facts.verificationState === "pending" ? ["Verification is pending"] : [],
          nextStep: "Wait for grounded verification",
        };
      },
    };
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const observer = new PassiveObserver({
      backend,
      persist: (input) => artifacts.recordObserverInterpretation(input),
      emit: (type, payload) => emitted.push({ type, payload }),
    });

    observer.observe(packet("Editing the implementation"));
    observer.observe(packet("Running the final check"));
    expect(calls).toBe(1);
    expect(emitted).toEqual([]);

    releaseFirst?.();
    await observer.dispose();

    expect(calls).toBe(2);
    expect(emitted.map((event) => event.type)).toEqual([
      "observer.interpretation",
      "observer.interpretation",
    ]);
    expect(artifacts.latestObserverInterpretation(packet("").taskId)).toMatchObject({
      summary: "Observed: Running the final check",
      risks: ["Verification is pending"],
      nextStep: "Wait for grounded verification",
      model: "observer/mock-mini",
    });
    artifacts.close();
  });

  test("reports observer failures without changing authoritative state", async () => {
    const artifacts = new ArtifactStore();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const observer = new PassiveObserver({
      backend: {
        model: "observer/failing",
        observe: async () => {
          throw new Error("provider unavailable");
        },
      },
      persist: (input) => artifacts.recordObserverInterpretation(input),
      emit: (type, payload) => emitted.push({ type, payload }),
    });

    observer.observe(packet("Editing"));
    await observer.dispose();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "observer.error",
      payload: { model: "observer/failing", error: "provider unavailable" },
    });
    expect(artifacts.latestObserverInterpretation(packet("").taskId)).toBeNull();
    artifacts.close();
  });
});
