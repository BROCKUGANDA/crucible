/**
 * @file spec-model-collapse.test.ts — one model, not two.
 *
 * The evaluation specification and the scoring engine used to carry their
 * own copies of the dimension names, the default weights and the number of
 * replays the rule needs. A rename in one place left the other scoring
 * dimensions the platform had never heard of, and a change to the replay
 * count changed the rule in one place and not the other.
 *
 * These tests are the collapse's guard: they assert that the specification
 * is BUILT from the scoring engine's list, and that both read the replay
 * rule from the one policy module.
 *
 * They also assert the weights sum to 1, because a table that sums to 1.05
 * produces an aggregate score above 100 and no test anywhere would notice.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_DIMENSIONS, DEFAULT_DIMENSION_WEIGHTS } from "../src/scoring.js";
import { REQUIRED_REPLAYS, DEFAULT_REPETITION_POLICY } from "../src/replay-policy.js";
import { generateEvaluationSpec } from "../src/evaluation-spec.js";
import { createSuite, createSuiteVersion, resetSuiteStore } from "../src/suites.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPEC_SOURCE = readFileSync(join(HERE, "..", "src", "evaluation-spec.ts"), "utf-8");

describe("the scoring model", () => {
  it("weights every dimension", () => {
    for (const dimension of ALL_DIMENSIONS) {
      expect(DEFAULT_DIMENSION_WEIGHTS[dimension]).toBeDefined();
    }
    expect(Object.keys(DEFAULT_DIMENSION_WEIGHTS).sort()).toEqual([...ALL_DIMENSIONS].sort());
  });

  it("weights the dimensions to exactly one", () => {
    const total = ALL_DIMENSIONS.reduce(
      (sum, dimension) => sum + DEFAULT_DIMENSION_WEIGHTS[dimension],
      0,
    );
    expect(total).toBeCloseTo(1, 10);
  });

  it("gives no dimension a negative weight", () => {
    for (const dimension of ALL_DIMENSIONS) {
      expect(DEFAULT_DIMENSION_WEIGHTS[dimension]).toBeGreaterThan(0);
    }
  });
});

describe("the evaluation specification", () => {
  it("names the scoring engine's dimensions rather than a second list", () => {
    // The source must not spell the dimensions out again: the list is the
    // scoring engine's, and the spec is built from it.
    expect(SPEC_SOURCE).not.toContain('name: "CORRECTNESS"');
    expect(SPEC_SOURCE).toContain("ALL_DIMENSIONS");
  });

  it("reads the replay rule from the policy module rather than naming a number", () => {
    expect(SPEC_SOURCE).not.toContain("independentReplays: 3");
    expect(SPEC_SOURCE).toContain("DEFAULT_REPETITION_POLICY");
  });

  it("publishes a spec whose methodology matches the scoring engine", () => {
    resetSuiteStore();
    const suite = createSuite({
      name: "Collapse suite",
      slug: "collapse-suite",
      maintainer: "someone",
      description: "",
    });
    createSuiteVersion({
      suiteId: suite.id,
      version: "1.0.0",
      schemaVersion: 1,
    });

    const spec = generateEvaluationSpec({
      trialId: "trial-1",
      trialRevision: "rev-1",
      suiteId: suite.id,
      agentId: "agent-1",
      taskSpecification: { summary: "a task" },
      inputFixtures: [],
      executionEnvironment: { runtimeImage: `img@sha256:${"cd".repeat(32)}` },
      runtimeConfig: {},
      resourceLimits: {},
      toolPermissions: [],
      judgeConfig: { judgeVersion: "judge/1" },
    });

    const dimensions = spec.scoringMethodology.dimensions.map((dimension) => dimension.name);
    expect([...dimensions].sort()).toEqual([...ALL_DIMENSIONS].sort());

    for (const dimension of spec.scoringMethodology.dimensions) {
      expect(dimension.weight).toBe(DEFAULT_DIMENSION_WEIGHTS[dimension.name as never]);
    }

    expect(spec.repetitionPolicy.independentReplays).toBe(REQUIRED_REPLAYS);
    expect(DEFAULT_REPETITION_POLICY.independentReplays).toBe(3);
    resetSuiteStore();
  });
});
