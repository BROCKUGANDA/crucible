import { describe, expect, it, beforeEach } from "vitest";
import {
  createSuite,
  createSuiteVersion,
  createAdversarialTest,
  getSuite,
  getSuiteBySlug,
  getSuiteVersion,
  getSuiteVersions,
  getLatestSuiteVersion,
  getAdversarialTest,
  getAdversarialTestsForSuiteVersion,
  listSuites,
  updateSuiteStatus,
  validateCreateSuiteInput,
  validateCreateSuiteVersionInput,
  validateCreateAdversarialTestInput,
  resetSuiteStore,
  type Suite,
  type SuiteVersion,
  type AdversarialTest,
} from "../src/suites";

const mockPrincipal = {
  address: "0x1234567890123456789012345678901234567890",
  orgId: "org-1",
  role: "org.owner",
} as any;

describe("suite validation", () => {
  it("rejects missing name", () => {
    const errors = validateCreateSuiteInput({
      name: "",
      slug: "test-suite",
      maintainer: "maintainer",
    });
    expect(errors).toContain("name is required");
  });

  it("rejects invalid slug format", () => {
    const errors = validateCreateSuiteInput({
      name: "Test Suite",
      slug: "INVALID-SLUG",
      maintainer: "maintainer",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects missing maintainer", () => {
    const errors = validateCreateSuiteInput({
      name: "Test Suite",
      slug: "test-suite",
      maintainer: "",
    });
    expect(errors).toContain("maintainer is required");
  });

  it("accepts valid input", () => {
    const errors = validateCreateSuiteInput({
      name: "Test Suite",
      slug: "test-suite",
      maintainer: "maintainer",
      visibility: "public",
    });
    expect(errors).toEqual([]);
  });
});

describe("suite version validation", () => {
  it("rejects missing suiteId", () => {
    const errors = validateCreateSuiteVersionInput({
      suiteId: "",
      version: "1.0.0",
    });
    expect(errors).toContain("suiteId is required");
  });

  it("rejects missing version", () => {
    const errors = validateCreateSuiteVersionInput({
      suiteId: "suite-1",
      version: "",
    });
    expect(errors).toContain("version is required");
  });

  it("rejects invalid difficulty", () => {
    const errors = validateCreateSuiteVersionInput({
      suiteId: "suite-1",
      version: "1.0.0",
      difficulty: "impossible" as any,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts valid input", () => {
    const errors = validateCreateSuiteVersionInput({
      suiteId: "suite-1",
      version: "1.0.0",
      difficulty: "hard",
      evaluationProtocol: "deterministic",
    });
    expect(errors).toEqual([]);
  });
});

describe("adversarial test validation", () => {
  it("rejects missing objective", () => {
    const errors = validateCreateAdversarialTestInput({
      suiteVersionId: "sv-1",
      name: "Test",
      category: "prompt_injection",
      objective: "",
      threatModel: "threat",
      expectedBehavior: "behavior",
      detectionCriteria: {},
      evidenceRequirements: {},
    });
    expect(errors).toContain("objective is required");
  });

  it("rejects invalid category", () => {
    const errors = validateCreateAdversarialTestInput({
      suiteVersionId: "sv-1",
      name: "Test",
      category: "invalid_category" as any,
      objective: "objective",
      threatModel: "threat",
      expectedBehavior: "behavior",
      detectionCriteria: {},
      evidenceRequirements: {},
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts valid input", () => {
    const errors = validateCreateAdversarialTestInput({
      suiteVersionId: "sv-1",
      name: "Prompt Injection Test",
      category: "prompt_injection",
      objective: "Test prompt injection resistance",
      threatModel: "Malicious user input",
      expectedBehavior: "Agent should reject injected instructions",
      detectionCriteria: { passThreshold: 0.9 },
      evidenceRequirements: { logs: true },
      severity: "high",
    });
    expect(errors).toEqual([]);
  });
});

describe("suite lifecycle", () => {
  beforeEach(() => {
    resetSuiteStore();
  });

  it("creates a suite with default values", () => {
    const suite = createSuite(
      {
        name: "Test Suite",
        slug: "test-suite",
        maintainer: "maintainer",
        orgId: "org-1",
      },
      mockPrincipal,
    );

    expect(suite.id).toBeDefined();
    expect(suite.name).toBe("Test Suite");
    expect(suite.slug).toBe("test-suite");
    expect(suite.status).toBe("DRAFT");
    expect(suite.visibility).toBe("public");
    expect(suite.orgId).toBe("org-1");
  });

  it("rejects duplicate slug within the same org", () => {
    createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m", orgId: "org-1" },
      mockPrincipal,
    );

    expect(() =>
      createSuite(
        { name: "Another Suite", slug: "test-suite", maintainer: "m", orgId: "org-1" },
        mockPrincipal,
      ),
    ).toThrow("already exists");
  });

  it("allows same slug in different orgs", () => {
    const suite1 = createSuite(
      { name: "Suite 1", slug: "test-suite", maintainer: "m", orgId: "org-1" },
      mockPrincipal,
    );
    const suite2 = createSuite(
      { name: "Suite 2", slug: "test-suite", maintainer: "m", orgId: "org-2" },
      mockPrincipal,
    );

    expect(suite1.id).not.toBe(suite2.id);
  });

  it("retrieves suite by id", () => {
    const created = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m", orgId: "org-1" },
      mockPrincipal,
    );
    const found = getSuite(created.id);
    expect(found).toEqual(created);
  });

  it("retrieves suite by slug and org", () => {
    const created = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m", orgId: "org-1" },
      mockPrincipal,
    );
    const found = getSuiteBySlug("test-suite", "org-1");
    expect(found).toEqual(created);
  });

  it("returns undefined for non-existent suite", () => {
    expect(getSuite("non-existent")).toBeUndefined();
  });

  it("transitions suite status forward", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    const published = updateSuiteStatus(suite.id, "PUBLISHED");
    expect(published?.status).toBe("PUBLISHED");

    const deprecated = updateSuiteStatus(suite.id, "DEPRECATED");
    expect(deprecated?.status).toBe("DEPRECATED");

    const archived = updateSuiteStatus(suite.id, "ARCHIVED");
    expect(archived?.status).toBe("ARCHIVED");
  });

  it("rejects backward status transitions", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    updateSuiteStatus(suite.id, "PUBLISHED");

    expect(() => updateSuiteStatus(suite.id, "DRAFT")).toThrow("Cannot transition");
  });

  it("rejects transitions from terminal state", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    updateSuiteStatus(suite.id, "PUBLISHED");
    updateSuiteStatus(suite.id, "ARCHIVED");

    expect(() => updateSuiteStatus(suite.id, "PUBLISHED")).toThrow("Cannot transition");
  });

  it("lists suites with filters", () => {
    createSuite(
      { name: "Public Suite", slug: "public-suite", maintainer: "m", visibility: "public" },
      mockPrincipal,
    );
    createSuite(
      { name: "Private Suite", slug: "private-suite", maintainer: "m", visibility: "private" },
      mockPrincipal,
    );
    createSuite(
      { name: "Org Suite", slug: "org-suite", maintainer: "m", visibility: "org" },
      mockPrincipal,
    );

    const publicSuites = listSuites({ visibility: "public" });
    expect(publicSuites).toHaveLength(1);
    expect(publicSuites[0]?.name).toBe("Public Suite");

    const allSuites = listSuites();
    expect(allSuites).toHaveLength(3);
  });

  it("searches suites by name", () => {
    createSuite(
      { name: "Math Benchmark", slug: "math", maintainer: "m" },
      mockPrincipal,
    );
    createSuite(
      { name: "Code Benchmark", slug: "code", maintainer: "m" },
      mockPrincipal,
    );

    const results = listSuites({ search: "math" });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Math Benchmark");
  });
});

describe("suite version lifecycle", () => {
  beforeEach(() => {
    resetSuiteStore();
  });

  it("creates a suite version", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    const version = createSuiteVersion(
      {
        suiteId: suite.id,
        version: "1.0.0",
        taskFamilies: ["math", "reasoning"],
        difficulty: "hard",
      },
      "digest-123",
    );

    expect(version.id).toBeDefined();
    expect(version.suiteId).toBe(suite.id);
    expect(version.version).toBe("1.0.0");
    expect(version.difficulty).toBe("hard");
    expect(version.specDigest).toBe("digest-123");
  });

  it("rejects version for non-existent suite", () => {
    expect(() =>
      createSuiteVersion(
        { suiteId: "non-existent", version: "1.0.0" },
        "digest",
      ),
    ).toThrow("not found");
  });

  it("rejects duplicate version", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    createSuiteVersion(
      { suiteId: suite.id, version: "1.0.0" },
      "digest-1",
    );

    expect(() =>
      createSuiteVersion(
        { suiteId: suite.id, version: "1.0.0" },
        "digest-2",
      ),
    ).toThrow("already exists");
  });

  it("retrieves versions sorted by version string", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    createSuiteVersion({ suiteId: suite.id, version: "2.0.0" }, "d2");
    createSuiteVersion({ suiteId: suite.id, version: "1.0.0" }, "d1");
    createSuiteVersion({ suiteId: suite.id, version: "1.5.0" }, "d15");

    const versions = getSuiteVersions(suite.id);
    expect(versions).toHaveLength(3);
    expect(versions[0]?.version).toBe("1.0.0");
    expect(versions[1]?.version).toBe("1.5.0");
    expect(versions[2]?.version).toBe("2.0.0");
  });

  it("returns the latest version", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    createSuiteVersion({ suiteId: suite.id, version: "1.0.0" }, "d1");
    createSuiteVersion({ suiteId: suite.id, version: "2.0.0" }, "d2");

    const latest = getLatestSuiteVersion(suite.id);
    expect(latest?.version).toBe("2.0.0");
  });

  it("returns undefined for empty suite", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );

    expect(getLatestSuiteVersion(suite.id)).toBeUndefined();
  });
});

describe("adversarial test lifecycle", () => {
  beforeEach(() => {
    resetSuiteStore();
  });

  it("creates an adversarial test", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );
    const version = createSuiteVersion(
      { suiteId: suite.id, version: "1.0.0" },
      "digest",
    );

    const test = createAdversarialTest({
      suiteVersionId: version.id,
      name: "Prompt Injection Test",
      category: "prompt_injection",
      objective: "Test prompt injection resistance",
      threatModel: "Malicious user input",
      expectedBehavior: "Agent should reject injected instructions",
      detectionCriteria: { passThreshold: 0.9 },
      evidenceRequirements: { logs: true },
      severity: "high",
    });

    expect(test.id).toBeDefined();
    expect(test.suiteVersionId).toBe(version.id);
    expect(test.category).toBe("prompt_injection");
    expect(test.severity).toBe("high");
  });

  it("rejects test for non-existent suite version", () => {
    expect(() =>
      createAdversarialTest({
        suiteVersionId: "non-existent",
        name: "Test",
        category: "prompt_injection",
        objective: "objective",
        threatModel: "threat",
        expectedBehavior: "behavior",
        detectionCriteria: {},
        evidenceRequirements: {},
      }),
    ).toThrow("not found");
  });

  it("rejects duplicate name within suite version", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );
    const version = createSuiteVersion(
      { suiteId: suite.id, version: "1.0.0" },
      "digest",
    );

    createAdversarialTest({
      suiteVersionId: version.id,
      name: "Test 1",
      category: "prompt_injection",
      objective: "obj",
      threatModel: "tm",
      expectedBehavior: "eb",
      detectionCriteria: {},
      evidenceRequirements: {},
    });

    expect(() =>
      createAdversarialTest({
        suiteVersionId: version.id,
        name: "Test 1",
        category: "jailbreak",
        objective: "obj",
        threatModel: "tm",
        expectedBehavior: "eb",
        detectionCriteria: {},
        evidenceRequirements: {},
      }),
    ).toThrow("already exists");
  });

  it("filters tests by category", () => {
    const suite = createSuite(
      { name: "Test Suite", slug: "test-suite", maintainer: "m" },
      mockPrincipal,
    );
    const version = createSuiteVersion(
      { suiteId: suite.id, version: "1.0.0" },
      "digest",
    );

    createAdversarialTest({
      suiteVersionId: version.id,
      name: "Test 1",
      category: "prompt_injection",
      objective: "obj",
      threatModel: "tm",
      expectedBehavior: "eb",
      detectionCriteria: {},
      evidenceRequirements: {},
    });
    createAdversarialTest({
      suiteVersionId: version.id,
      name: "Test 2",
      category: "jailbreak",
      objective: "obj",
      threatModel: "tm",
      expectedBehavior: "eb",
      detectionCriteria: {},
      evidenceRequirements: {},
    });

    const injectionTests = getAdversarialTestsForSuiteVersion(version.id, {
      category: "prompt_injection",
    });
    expect(injectionTests).toHaveLength(1);
    expect(injectionTests[0]?.category).toBe("prompt_injection");

    const allTests = getAdversarialTestsForSuiteVersion(version.id);
    expect(allTests).toHaveLength(2);
  });
});
