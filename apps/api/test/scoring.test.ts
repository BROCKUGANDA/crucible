import { describe, expect, it, beforeEach } from "vitest";
import {
  createRubric,
  createDimensionScore,
  createAggregateScore,
  getRubric,
  getActiveRubric,
  getDimensionScores,
  getDimensionScore,
  getAggregateScore,
  updateAggregateScoreStatus,
  computeAggregateScore,
  wilsonScoreInterval,
  calculateVariance,
  assertNoFinancialData,
  validateCreateRubricInput,
  validateCreateDimensionScoreInput,
  isValidScore,
  isValidWeight,
  resetScoringStore,
  ALL_DIMENSIONS,
  type DimensionScore,
} from "../src/scoring";

describe("score validation", () => {
  it("accepts scores in [0, 1]", () => {
    expect(isValidScore(0)).toBe(true);
    expect(isValidScore(1)).toBe(true);
    expect(isValidScore(0.5)).toBe(true);
  });

  it("rejects scores outside [0, 1]", () => {
    expect(isValidScore(-0.1)).toBe(false);
    expect(isValidScore(1.1)).toBe(false);
  });

  it("accepts weights in [0, 1]", () => {
    expect(isValidWeight(0)).toBe(true);
    expect(isValidWeight(1)).toBe(true);
    expect(isValidWeight(0.2)).toBe(true);
  });

  it("rejects weights outside [0, 1]", () => {
    expect(isValidWeight(-0.1)).toBe(false);
    expect(isValidWeight(1.1)).toBe(false);
  });
});

describe("rubric validation", () => {
  it("rejects missing name", () => {
    const errors = validateCreateRubricInput({
      name: "",
      dimensions: [],
    });
    expect(errors).toContain("name is required");
  });

  it("rejects empty dimensions", () => {
    const errors = validateCreateRubricInput({
      name: "Test Rubric",
      dimensions: [],
    });
    expect(errors).toContain("at least one dimension is required");
  });

  it("rejects invalid dimension", () => {
    const errors = validateCreateRubricInput({
      name: "Test Rubric",
      dimensions: [
        { dimension: "INVALID" as any, weight: 1, methodology: "test" },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects duplicate dimensions", () => {
    const errors = validateCreateRubricInput({
      name: "Test Rubric",
      dimensions: [
        { dimension: "CORRECTNESS", weight: 0.5, methodology: "test" },
        { dimension: "CORRECTNESS", weight: 0.5, methodology: "test" },
      ],
    });
    expect(errors).toContain("Duplicate dimension: CORRECTNESS");
  });

  it("rejects weights that don't sum to 1.0", () => {
    const errors = validateCreateRubricInput({
      name: "Test Rubric",
      dimensions: [
        { dimension: "CORRECTNESS", weight: 0.1, methodology: "test" },
        { dimension: "ROBUSTNESS", weight: 0.1, methodology: "test" },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts valid rubric with all five dimensions", () => {
    const errors = validateCreateRubricInput({
      name: "Standard Rubric",
      dimensions: ALL_DIMENSIONS.map((dim) => ({
        dimension: dim,
        weight: 0.2,
        methodology: "automated",
      })),
    });
    expect(errors).toEqual([]);
  });
});

describe("dimension score validation", () => {
  it("rejects missing runId", () => {
    const errors = validateCreateDimensionScoreInput({
      runId: "",
      rubricId: "rubric-1",
      dimension: "CORRECTNESS",
      score: 0.5,
      methodology: "test",
    });
    expect(errors).toContain("runId is required");
  });

  it("rejects score out of range", () => {
    const errors = validateCreateDimensionScoreInput({
      runId: "run-1",
      rubricId: "rubric-1",
      dimension: "CORRECTNESS",
      score: 1.5,
      methodology: "test",
    });
    expect(errors).toContain("score must be in [0, 1]");
  });

  it("rejects invalid confidence interval", () => {
    const errors = validateCreateDimensionScoreInput({
      runId: "run-1",
      rubricId: "rubric-1",
      dimension: "CORRECTNESS",
      score: 0.5,
      methodology: "test",
      confidenceLower: 0.8,
      confidenceUpper: 0.2,
    });
    expect(errors).toContain("confidenceLower must be <= confidenceUpper");
  });

  it("accepts valid dimension score", () => {
    const errors = validateCreateDimensionScoreInput({
      runId: "run-1",
      rubricId: "rubric-1",
      dimension: "CORRECTNESS",
      score: 0.85,
      methodology: "automated",
      sampleCount: 10,
      confidenceLower: 0.7,
      confidenceUpper: 0.95,
    });
    expect(errors).toEqual([]);
  });
});

describe("rubric lifecycle", () => {
  beforeEach(() => {
    resetScoringStore();
  });

  it("creates a rubric", () => {
    const rubric = createRubric({
      name: "Standard Rubric",
      description: "Standard 5-dimension rubric",
      dimensions: ALL_DIMENSIONS.map((dim) => ({
        dimension: dim,
        weight: 0.2,
        methodology: "automated",
      })),
    });

    expect(rubric.id).toBeDefined();
    expect(rubric.name).toBe("Standard Rubric");
    expect(rubric.status).toBe("ACTIVE");
    expect(rubric.version).toBe("1");
    expect(rubric.dimensions).toHaveLength(5);
  });

  it("rejects duplicate name + version", () => {
    createRubric({
      name: "Test Rubric",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });

    expect(() =>
      createRubric({
        name: "Test Rubric",
        version: "1",
        dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
      }),
    ).toThrow("already exists");
  });

  it("allows same name with different version", () => {
    const rubric1 = createRubric({
      name: "Test Rubric",
      version: "1",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });
    const rubric2 = createRubric({
      name: "Test Rubric",
      version: "2",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });

    expect(rubric1.id).not.toBe(rubric2.id);
    expect(rubric1.version).toBe("1");
    expect(rubric2.version).toBe("2");
  });

  it("retrieves rubric by id", () => {
    const created = createRubric({
      name: "Test Rubric",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });
    const found = getRubric(created.id);
    expect(found).toEqual(created);
  });

  it("retrieves active rubric by name", () => {
    const created = createRubric({
      name: "Test Rubric",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });
    const found = getActiveRubric("Test Rubric");
    expect(found).toEqual(created);
  });
});

describe("dimension score lifecycle", () => {
  beforeEach(() => {
    resetScoringStore();
  });

  it("creates a dimension score", () => {
    const rubric = createRubric({
      name: "Test Rubric",
      dimensions: ALL_DIMENSIONS.map((dim) => ({
        dimension: dim,
        weight: 0.2,
        methodology: "automated",
      })),
    });

    const score = createDimensionScore({
      runId: "run-1",
      rubricId: rubric.id,
      dimension: "CORRECTNESS",
      score: 0.85,
      methodology: "automated",
      sampleCount: 10,
    });

    expect(score.id).toBeDefined();
    expect(score.runId).toBe("run-1");
    expect(score.dimension).toBe("CORRECTNESS");
    expect(score.score).toBe(0.85);
    expect(score.weight).toBe(0.2);
  });

  it("rejects score for non-existent rubric", () => {
    expect(() =>
      createDimensionScore({
        runId: "run-1",
        rubricId: "non-existent",
        dimension: "CORRECTNESS",
        score: 0.5,
        methodology: "test",
      }),
    ).toThrow("not found");
  });

  it("rejects duplicate dimension for the same run", () => {
    const rubric = createRubric({
      name: "Test Rubric",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });

    createDimensionScore({
      runId: "run-1",
      rubricId: rubric.id,
      dimension: "CORRECTNESS",
      score: 0.5,
      methodology: "test",
    });

    expect(() =>
      createDimensionScore({
        runId: "run-1",
        rubricId: rubric.id,
        dimension: "CORRECTNESS",
        score: 0.6,
        methodology: "test",
      }),
    ).toThrow("already exists");
  });

  it("retrieves all dimension scores for a run", () => {
    const rubric = createRubric({
      name: "Test Rubric",
      dimensions: ALL_DIMENSIONS.map((dim) => ({
        dimension: dim,
        weight: 0.2,
        methodology: "automated",
      })),
    });

    for (const dim of ALL_DIMENSIONS) {
      createDimensionScore({
        runId: "run-1",
        rubricId: rubric.id,
        dimension: dim,
        score: 0.8,
        methodology: "automated",
      });
    }

    const scores = getDimensionScores("run-1");
    expect(scores).toHaveLength(5);
  });

  it("retrieves specific dimension score", () => {
    const rubric = createRubric({
      name: "Test Rubric",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });

    createDimensionScore({
      runId: "run-1",
      rubricId: rubric.id,
      dimension: "CORRECTNESS",
      score: 0.9,
      methodology: "automated",
    });

    const score = getDimensionScore("run-1", "CORRECTNESS");
    expect(score?.score).toBe(0.9);
  });
});

describe("aggregate score computation", () => {
  beforeEach(() => {
    resetScoringStore();
  });

  it("computes weighted average correctly", () => {
    const dimensionScores: DimensionScore[] = [
      {
        id: "1",
        runId: "run-1",
        rubricId: "rubric-1",
        dimension: "CORRECTNESS",
        score: 1.0,
        weight: 0.5,
        evidence: {},
        methodology: "test",
        sampleCount: 10,
        confidenceLower: null,
        confidenceUpper: null,
        variance: null,
        judgeId: null,
        judgeDecision: null,
        createdAt: Date.now(),
      },
      {
        id: "2",
        runId: "run-1",
        rubricId: "rubric-1",
        dimension: "SAFETY",
        score: 0.5,
        weight: 0.5,
        evidence: {},
        methodology: "test",
        sampleCount: 10,
        confidenceLower: null,
        confidenceUpper: null,
        variance: null,
        judgeId: null,
        judgeDecision: null,
        createdAt: Date.now(),
      },
    ];

    const result = computeAggregateScore(dimensionScores, "weighted");
    expect(result.score).toBe(0.75);
    expect(result.sampleCount).toBe(20);
  });

  it("returns zero for empty scores", () => {
    const result = computeAggregateScore([], "test");
    expect(result.score).toBe(0);
    expect(result.sampleCount).toBe(0);
  });

  it("creates aggregate score from dimension scores", () => {
    const rubric = createRubric({
      name: "Test Rubric",
      dimensions: ALL_DIMENSIONS.map((dim) => ({
        dimension: dim,
        weight: 0.2,
        methodology: "automated",
      })),
    });

    for (const dim of ALL_DIMENSIONS) {
      createDimensionScore({
        runId: "run-1",
        rubricId: rubric.id,
        dimension: dim,
        score: 0.8,
        methodology: "automated",
      });
    }

    const aggregate = createAggregateScore("run-1", rubric.id, "weighted");
    expect(aggregate).not.toBeNull();
    expect(aggregate?.score).toBeCloseTo(0.8, 10);
    expect(aggregate?.status).toBe("PROVISIONAL");
  });

  it("returns null for run with no dimension scores", () => {
    const rubric = createRubric({
      name: "Test Rubric",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });

    const aggregate = createAggregateScore("run-1", rubric.id, "weighted");
    expect(aggregate).toBeNull();
  });

  it("updates aggregate score status", () => {
    const rubric = createRubric({
      name: "Test Rubric",
      dimensions: [{ dimension: "CORRECTNESS", weight: 1, methodology: "test" }],
    });

    createDimensionScore({
      runId: "run-1",
      rubricId: rubric.id,
      dimension: "CORRECTNESS",
      score: 0.8,
      methodology: "automated",
    });

    createAggregateScore("run-1", rubric.id, "weighted");
    const updated = updateAggregateScoreStatus("run-1", "VERIFIED");
    expect(updated?.status).toBe("VERIFIED");
  });
});

describe("statistical functions", () => {
  it("calculates Wilson score interval", () => {
    const result = wilsonScoreInterval(9, 10);
    expect(result).not.toBeNull();
    expect(result!.lower).toBeGreaterThan(0);
    expect(result!.upper).toBeLessThan(1);
    expect(result!.lower).toBeLessThan(result!.upper);
  });

  it("returns null for zero total", () => {
    expect(wilsonScoreInterval(0, 0)).toBeNull();
  });

  it("calculates variance", () => {
    const variance = calculateVariance([1, 2, 3, 4, 5]);
    expect(variance).toBeGreaterThan(0);
  });

  it("returns null for single value", () => {
    expect(calculateVariance([1])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(calculateVariance([])).toBeNull();
  });
});

describe("score/reward isolation", () => {
  it("allows non-financial data", () => {
    expect(() =>
      assertNoFinancialData({
        score: 0.8,
        dimension: "CORRECTNESS",
        evidence: { passed: true },
      }),
    ).not.toThrow();
  });

  it("rejects data with reward key", () => {
    expect(() =>
      assertNoFinancialData({
        score: 0.8,
        reward: "1000000000000000000",
      }),
    ).toThrow("Score/reward isolation violation");
  });

  it("rejects data with budget key", () => {
    expect(() =>
      assertNoFinancialData({
        score: 0.8,
        budget: "5000000000000000000",
      }),
    ).toThrow("Score/reward isolation violation");
  });

  it("rejects data with wallet key", () => {
    expect(() =>
      assertNoFinancialData({
        score: 0.8,
        wallet: "0x1234567890123456789012345678901234567890",
      }),
    ).toThrow("Score/reward isolation violation");
  });
});
