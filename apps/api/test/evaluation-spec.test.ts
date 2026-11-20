import { describe, it, expect, beforeEach } from "vitest";
import {
  generateEvaluationSpec,
  publishSpec,
  getEvaluationSpec,
  listSpecsByTrial,
  listSpecsBySuite,
  computeSpecDigest,
  resetSpecStore,
} from "../src/evaluation-spec.js";
import {
  createSuite,
  createSuiteVersion,
  resetSuiteStore,
} from "../src/suites.js";

describe("evaluation-spec", () => {
  beforeEach(() => {
    resetSpecStore();
    resetSuiteStore();
  });

  const testPrincipal = { orgId: "org-1", address: "0x1234" };

  describe("generateEvaluationSpec", () => {
    it("generates a spec from suite and agent", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"] },
        testPrincipal,
      );

      const spec = generateEvaluationSpec({
        trialId: "trial-1",
        suiteId: suite.id,
        agentId: "agent-1",
        executionEnvironment: { runtimeImage: "node:20" },
      });

      expect(spec.specId).toBeDefined();
      expect(spec.trialId).toBe("trial-1");
      expect(spec.suiteId).toBe(suite.id);
      expect(spec.agentId).toBe("agent-1");
      expect(spec.status).toBe("DRAFT");
      expect(spec.specDigest).toBeDefined();
      expect(spec.scoringMethodology.dimensions.length).toBeGreaterThan(0);
    });

    it("rejects missing trialId", () => {
      expect(() =>
        generateEvaluationSpec({
          trialId: "",
          suiteId: "suite-1",
          agentId: "agent-1",
          executionEnvironment: { runtimeImage: "node:20" },
        }),
      ).toThrow("trialId is required");
    });

    it("rejects missing suiteId", () => {
      expect(() =>
        generateEvaluationSpec({
          trialId: "trial-1",
          suiteId: "",
          agentId: "agent-1",
          executionEnvironment: { runtimeImage: "node:20" },
        }),
      ).toThrow("suiteId is required");
    });

    it("rejects unknown suite", () => {
      expect(() =>
        generateEvaluationSpec({
          trialId: "trial-1",
          suiteId: "nonexistent",
          agentId: "agent-1",
          executionEnvironment: { runtimeImage: "node:20" },
        }),
      ).toThrow("not found");
    });

    it("rejects invalid scoring methodology", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"] },
        testPrincipal,
      );

      expect(() =>
        generateEvaluationSpec({
          trialId: "trial-1",
          suiteId: suite.id,
          agentId: "agent-1",
          executionEnvironment: { runtimeImage: "node:20" },
          scoringMethodology: {
            dimensions: [{ name: "CORRECTNESS", weight: 2.0 }],
          },
        }),
      ).toThrow("weight must be in [0, 1]");
    });

    it("uses default scoring methodology", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"] },
        testPrincipal,
      );

      const spec = generateEvaluationSpec({
        trialId: "trial-1",
        suiteId: suite.id,
        agentId: "agent-1",
        executionEnvironment: { runtimeImage: "node:20" },
      });

      expect(spec.scoringMethodology.dimensions.length).toBe(5);
      expect(spec.scoringMethodology.aggregateMethod).toBe("weighted_average");
    });

    it("uses suite protocol when not specified", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"], evaluationProtocol: "stochastic" },
        testPrincipal,
      );

      const spec = generateEvaluationSpec({
        trialId: "trial-1",
        suiteId: suite.id,
        agentId: "agent-1",
        executionEnvironment: { runtimeImage: "node:20" },
      });

      expect(spec.evaluationProtocol).toBe("stochastic");
    });
  });

  describe("publishSpec", () => {
    it("publishes a draft spec", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"] },
        testPrincipal,
      );

      const spec = generateEvaluationSpec({
        trialId: "trial-1",
        suiteId: suite.id,
        agentId: "agent-1",
        executionEnvironment: { runtimeImage: "node:20" },
      });

      const published = publishSpec(spec.specId);
      expect(published.status).toBe("PUBLISHED");
    });

    it("rejects non-draft spec", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"] },
        testPrincipal,
      );

      const spec = generateEvaluationSpec({
        trialId: "trial-1",
        suiteId: suite.id,
        agentId: "agent-1",
        executionEnvironment: { runtimeImage: "node:20" },
      });
      publishSpec(spec.specId);

      expect(() => publishSpec(spec.specId)).toThrow("cannot publish");
    });

    it("rejects unknown spec", () => {
      expect(() => publishSpec("nonexistent")).toThrow("not found");
    });
  });

  describe("listSpecsByTrial", () => {
    it("lists specs by trial", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"] },
        testPrincipal,
      );

      generateEvaluationSpec({
        trialId: "trial-1",
        suiteId: suite.id,
        agentId: "agent-1",
        executionEnvironment: { runtimeImage: "node:20" },
      });
      generateEvaluationSpec({
        trialId: "trial-2",
        suiteId: suite.id,
        agentId: "agent-2",
        executionEnvironment: { runtimeImage: "node:20" },
      });

      expect(listSpecsByTrial("trial-1").length).toBe(1);
      expect(listSpecsByTrial("trial-2").length).toBe(1);
    });
  });

  describe("computeSpecDigest", () => {
    it("produces consistent digest", () => {
      const suite = createSuite(
        { name: "Test Suite", slug: "test-suite", maintainer: "test" },
        testPrincipal,
      );
      createSuiteVersion(
        { suiteId: suite.id, version: "1", taskFamilies: ["coding"] },
        testPrincipal,
      );

      const spec = generateEvaluationSpec({
        trialId: "trial-1",
        suiteId: suite.id,
        agentId: "agent-1",
        executionEnvironment: { runtimeImage: "node:20" },
      });

      const digest1 = computeSpecDigest(spec);
      const digest2 = computeSpecDigest(spec);
      expect(digest1).toBe(digest2);
      expect(digest1.length).toBe(64);
    });
  });
});
