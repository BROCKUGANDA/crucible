import { describe, expect, it } from "vitest";
import {
  PIPELINE_FAILURE_STATES,
  PipelineTransitionError,
  assertPipelineTransition,
  canPublishOutput,
  canTransitionPipeline,
  failPipeline,
  isPipelineFailure,
  isTerminalPipelineState,
  nextPipelineStates,
} from "../src/pipeline.js";

describe("pipeline lifecycle", () => {
  it("walks the documented happy path in order", () => {
    const path = [
      "SOURCE_REGISTERED",
      "SOURCE_SNAPSHOT_PINNED",
      "CONTRACT_DRAFTED",
      "CONTRACT_VALIDATED",
      "MAPPING_APPROVED",
      "PIPELINE_PUBLISHED",
      "RUN_QUEUED",
      "EXTRACTING",
      "TRANSFORMING",
      "VALIDATING",
      "STAGING_OUTPUT",
      "RECONCILING",
      "VERIFIED",
      "PUBLISHED_OUTPUT",
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionPipeline(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("cannot publish straight from staging", () => {
    // §4.4: a failed pipeline must not publish partial output, and reconciled
    // evidence is the only thing that may publish at all.
    expect(canTransitionPipeline("STAGING_OUTPUT", "PUBLISHED_OUTPUT")).toBe(false);
    expect(() => assertPipelineTransition("STAGING_OUTPUT", "PUBLISHED_OUTPUT")).toThrow(
      PipelineTransitionError,
    );
  });

  it("has exactly one edge into PUBLISHED_OUTPUT", () => {
    const all = ["SOURCE_REGISTERED", "VERIFIED", "STAGING_OUTPUT", "RECONCILING", "PUBLISHED_OUTPUT"] as const;
    const entrants = all.filter((from) => canTransitionPipeline(from, "PUBLISHED_OUTPUT"));
    expect(entrants).toEqual(["VERIFIED"]);
    expect(canPublishOutput("VERIFIED")).toBe(true);
    expect(canPublishOutput("STAGING_OUTPUT")).toBe(false);
  });

  it("makes every failure terminal", () => {
    for (const failure of PIPELINE_FAILURE_STATES) {
      expect(isPipelineFailure(failure), failure).toBe(true);
      expect(isTerminalPipelineState(failure), failure).toBe(true);
      expect(nextPipelineStates(failure), failure).toEqual([]);
      expect(canTransitionPipeline(failure, "PUBLISHED_OUTPUT"), failure).toBe(false);
    }
  });

  it("refuses a failure the stage could not have produced", () => {
    // Validating has not written anything, so a duplicate write cannot be the
    // reason it failed.
    expect(() => failPipeline("VALIDATING", "DUPLICATE_WRITE")).toThrow(PipelineTransitionError);
    // Extracting has not classified data yet, so it cannot have breached PII.
    expect(() => failPipeline("EXTRACTING", "PII_POLICY_VIOLATION")).toThrow(PipelineTransitionError);
    // The ones that can happen there are allowed.
    expect(failPipeline("VALIDATING", "QUALITY_CHECK_FAILED").to).toBe("QUALITY_CHECK_FAILED");
    expect(failPipeline("STAGING_OUTPUT", "DUPLICATE_WRITE").to).toBe("DUPLICATE_WRITE");
  });

  it("treats a published output as terminal, not as an editable state", () => {
    expect(isTerminalPipelineState("PUBLISHED_OUTPUT")).toBe(true);
    expect(nextPipelineStates("PUBLISHED_OUTPUT")).toEqual([]);
  });

  it("explains the staging refusal in words an operator can act on", () => {
    try {
      assertPipelineTransition("STAGING_OUTPUT", "PUBLISHED_OUTPUT");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineTransitionError);
      expect((err as Error).message).toMatch(/staged, reconciled and verified/);
    }
  });
});
