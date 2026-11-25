/**
 * @file suites.ts — Benchmark suite registry (Phase 1-2).
 *
 * Manages versioned benchmark suites, suite versions, and associated
 * adversarial tests. Suites are the top-level container for evaluation
 * tasks; versions are immutable snapshots.
 *
 * Consistent with the data model in migrations/0008_evaluation_integrity.sql.
 * All timestamps are Unix milliseconds.
 */

import { randomUUID } from "node:crypto";
import { hashCanonical } from "@crucible/crypto";
import type { OrganisationPrincipal } from "@crucible/agent-security";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type SuiteVisibility = "public" | "org" | "private";
export type SuiteStatus = "DRAFT" | "PUBLISHED" | "DEPRECATED" | "ARCHIVED";
export type Difficulty = "easy" | "medium" | "hard" | "expert" | "unknown";
export type EvaluationProtocol = "deterministic" | "stochastic" | "hybrid";

export interface Suite {
  id: string;
  orgId: string | null;
  name: string;
  slug: string;
  description: string;
  maintainer: string;
  visibility: SuiteVisibility;
  status: SuiteStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SuiteVersion {
  id: string;
  suiteId: string;
  version: string;
  schemaVersion: number;
  taskFamilies: string[];
  capabilityDomains: string[];
  difficulty: Difficulty;
  evaluationProtocol: EvaluationProtocol;
  scoringRules: Record<string, unknown>;
  testFixtures: Record<string, unknown>;
  requiredTools: unknown[];
  runtimeConstraints: Record<string, unknown>;
  safetyRequirements: Record<string, unknown>;
  expectedArtifacts: unknown[];
  validationRules: Record<string, unknown>;
  knownLimitations: string;
  changelog: string;
  specDigest: string;
  publishedAt: number | null;
  createdAt: number;
}

export interface AdversarialCategoryInfo {
  readonly category: string;
  readonly label: string;
}

export const ADVERSARIAL_CATEGORIES: AdversarialCategoryInfo[] = [
  { category: "prompt_injection", label: "Prompt Injection" },
  { category: "tool_misuse", label: "Tool Misuse" },
  { category: "privilege_escalation", label: "Privilege Escalation" },
  { category: "instruction_hierarchy", label: "Instruction Hierarchy" },
  { category: "malicious_content", label: "Malicious Content" },
  { category: "data_leakage", label: "Data Leakage" },
  { category: "secret_exposure", label: "Secret Exposure" },
  { category: "jailbreak", label: "Jailbreak" },
  { category: "unsafe_code", label: "Unsafe Code" },
  { category: "sandbox_escape", label: "Sandbox Escape" },
  { category: "resource_exhaustion", label: "Resource Exhaustion" },
  { category: "infinite_loop", label: "Infinite Loop" },
  { category: "denial_of_service", label: "Denial of Service" },
  { category: "self_modification", label: "Self Modification" },
  { category: "permission_bypass", label: "Permission Bypass" },
  { category: "context_contamination", label: "Context Contamination" },
  { category: "evaluation_gaming", label: "Evaluation Gaming" },
  { category: "benchmark_leakage", label: "Benchmark Leakage" },
  { category: "agent_collusion", label: "Agent Collusion" },
  { category: "sybil_identity", label: "Sybil Identity" },
  { category: "other", label: "Other" },
] as const;

export type AdversarialTestCategory = (typeof ADVERSARIAL_CATEGORIES)[number]["category"];
export type AdversarialTestSeverity = "low" | "medium" | "high" | "critical";

export interface AdversarialTest {
  id: string;
  suiteVersionId: string;
  name: string;
  category: AdversarialTestCategory;
  objective: string;
  threatModel: string;
  expectedBehavior: string;
  detectionCriteria: Record<string, unknown>;
  evidenceRequirements: Record<string, unknown>;
  testConfig: Record<string, unknown>;
  severity: AdversarialTestSeverity;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Input validation                                                   */
/* ------------------------------------------------------------------ */

export interface CreateSuiteInput {
  name: string;
  slug: string;
  description?: string;
  maintainer: string;
  visibility?: SuiteVisibility;
  orgId?: string | null;
}

export interface CreateSuiteVersionInput {
  suiteId: string;
  version: string;
  schemaVersion?: number;
  taskFamilies?: string[];
  capabilityDomains?: string[];
  difficulty?: Difficulty;
  evaluationProtocol?: EvaluationProtocol;
  scoringRules?: Record<string, unknown>;
  testFixtures?: Record<string, unknown>;
  requiredTools?: unknown[];
  runtimeConstraints?: Record<string, unknown>;
  safetyRequirements?: Record<string, unknown>;
  expectedArtifacts?: unknown[];
  validationRules?: Record<string, unknown>;
  knownLimitations?: string;
  changelog?: string;
}

export interface CreateAdversarialTestInput {
  suiteVersionId: string;
  name: string;
  category: AdversarialTestCategory;
  objective: string;
  threatModel: string;
  expectedBehavior: string;
  detectionCriteria: Record<string, unknown>;
  evidenceRequirements: Record<string, unknown>;
  testConfig?: Record<string, unknown>;
  severity?: AdversarialTestSeverity;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                 */
/* ------------------------------------------------------------------ */

const VALID_VISIBILITY: Set<SuiteVisibility> = new Set(["public", "org", "private"]);
const VALID_STATUS: Set<SuiteStatus> = new Set(["DRAFT", "PUBLISHED", "DEPRECATED", "ARCHIVED"]);
const VALID_DIFFICULTY: Set<Difficulty> = new Set(["easy", "medium", "hard", "expert", "unknown"]);
const VALID_PROTOCOL: Set<EvaluationProtocol> = new Set(["deterministic", "stochastic", "hybrid"]);
const VALID_SEVERITY: Set<AdversarialTestSeverity> = new Set(["low", "medium", "high", "critical"]);
const VALID_CATEGORIES = new Set(ADVERSARIAL_CATEGORIES.map((c) => c.category));

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function validateCreateSuiteInput(input: CreateSuiteInput): string[] {
  const errors: string[] = [];

  if (!input.name || input.name.trim().length < 1) {
    errors.push("name is required");
  }
  if (input.name.length > 256) {
    errors.push("name must be 256 characters or less");
  }

  if (!input.slug || !SLUG_REGEX.test(input.slug)) {
    errors.push("slug must match /^[a-z0-9][a-z0-9-]*[a-z0-9]$/");
  }

  if (!input.maintainer || input.maintainer.trim().length < 1) {
    errors.push("maintainer is required");
  }

  if (input.visibility && !VALID_VISIBILITY.has(input.visibility)) {
    errors.push(`visibility must be one of: ${[...VALID_VISIBILITY].join(", ")}`);
  }

  return errors;
}

export function validateCreateSuiteVersionInput(input: CreateSuiteVersionInput): string[] {
  const errors: string[] = [];

  if (!input.suiteId) {
    errors.push("suiteId is required");
  }
  if (!input.version || input.version.trim().length < 1) {
    errors.push("version is required");
  }
  if (input.schemaVersion && (input.schemaVersion < 1 || input.schemaVersion > 100)) {
    errors.push("schemaVersion must be between 1 and 100");
  }
  if (input.difficulty && !VALID_DIFFICULTY.has(input.difficulty)) {
    errors.push(`difficulty must be one of: ${[...VALID_DIFFICULTY].join(", ")}`);
  }
  if (input.evaluationProtocol && !VALID_PROTOCOL.has(input.evaluationProtocol)) {
    errors.push(`evaluationProtocol must be one of: ${[...VALID_PROTOCOL].join(", ")}`);
  }

  return errors;
}

export function validateCreateAdversarialTestInput(input: CreateAdversarialTestInput): string[] {
  const errors: string[] = [];

  if (!input.suiteVersionId) {
    errors.push("suiteVersionId is required");
  }
  if (!input.name || input.name.trim().length < 1) {
    errors.push("name is required");
  }
  if (!VALID_CATEGORIES.has(input.category)) {
    errors.push(`category must be one of: ${[...VALID_CATEGORIES].join(", ")}`);
  }
  if (!input.objective || input.objective.trim().length < 1) {
    errors.push("objective is required");
  }
  if (!input.threatModel || input.threatModel.trim().length < 1) {
    errors.push("threatModel is required");
  }
  if (!input.expectedBehavior || input.expectedBehavior.trim().length < 1) {
    errors.push("expectedBehavior is required");
  }
  if (input.severity && !VALID_SEVERITY.has(input.severity)) {
    errors.push(`severity must be one of: ${[...VALID_SEVERITY].join(", ")}`);
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* In-memory store (until PostgreSQL integration)                     */
/* ------------------------------------------------------------------ */

interface SuiteStore {
  suites: Map<string, Suite>;
  suiteVersions: Map<string, SuiteVersion>;
  adversarialTests: Map<string, AdversarialTest>;
  nextId: number;
}

const store: SuiteStore = {
  suites: new Map(),
  suiteVersions: new Map(),
  adversarialTests: new Map(),
  nextId: 1,
};

/* ------------------------------------------------------------------ */
/* Suite operations                                                   */
/* ------------------------------------------------------------------ */

export function createSuite(
  input: CreateSuiteInput,
  principal: OrganisationPrincipal,
): Suite {
  const errors = validateCreateSuiteInput(input);
  if (errors.length > 0) {
    throw new Error(`Invalid suite input: ${errors.join("; ")}`);
  }

  const now = Date.now();
  const id = randomUUID();
  const slug = input.slug.toLowerCase();

  // Check for duplicate slug within the same org
  for (const [, suite] of store.suites) {
    if (suite.slug === slug && suite.orgId === input.orgId) {
      throw new Error(`Suite with slug "${slug}" already exists in this organization`);
    }
  }

  const suite: Suite = {
    id,
    orgId: input.orgId ?? null,
    name: input.name.trim(),
    slug,
    description: input.description?.trim() ?? "",
    maintainer: input.maintainer.trim(),
    visibility: input.visibility ?? "public",
    status: "DRAFT",
    createdAt: now,
    updatedAt: now,
  };

  store.suites.set(id, suite);
  return suite;
}

export function getSuite(id: string): Suite | undefined {
  return store.suites.get(id);
}

export function getSuiteBySlug(slug: string, orgId: string | null): Suite | undefined {
  const normalizedSlug = slug.toLowerCase();
  for (const [, suite] of store.suites) {
    if (suite.slug === normalizedSlug && suite.orgId === orgId) {
      return suite;
    }
  }
  return undefined;
}

export function listSuites(filters: {
  visibility?: SuiteVisibility;
  status?: SuiteStatus;
  orgId?: string;
  search?: string;
} = {}): Suite[] {
  const suites: Suite[] = [];

  for (const [, suite] of store.suites) {
    if (filters.visibility && suite.visibility !== filters.visibility) continue;
    if (filters.status && suite.status !== filters.status) continue;
    if (filters.orgId && suite.orgId !== filters.orgId) continue;
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      const matchesName = suite.name.toLowerCase().includes(searchLower);
      const matchesDescription = suite.description.toLowerCase().includes(searchLower);
      if (!matchesName && !matchesDescription) continue;
    }
    suites.push(suite);
  }

  return suites;
}

export function updateSuiteStatus(id: string, status: SuiteStatus): Suite | null {
  const suite = store.suites.get(id);
  if (!suite) return null;

  // Only allow forward transitions
  const allowedTransitions: Record<SuiteStatus, SuiteStatus[]> = {
    DRAFT: ["PUBLISHED", "ARCHIVED"],
    PUBLISHED: ["DEPRECATED", "ARCHIVED"],
    DEPRECATED: ["ARCHIVED"],
    ARCHIVED: [],
  };

  if (!allowedTransitions[suite.status].includes(status)) {
    throw new Error(
      `Cannot transition suite from ${suite.status} to ${status}. Allowed: ${allowedTransitions[suite.status].join(", ")}`,
    );
  }

  suite.status = status;
  suite.updatedAt = Date.now();
  store.suites.set(id, suite);
  return suite;
}

/* ------------------------------------------------------------------ */
/* Suite version operations                                           */
/* ------------------------------------------------------------------ */

/**
 * The content address of a suite version.
 *
 * A suite version says WHAT is measured: the task families, the protocol,
 * the scoring rules, the fixtures, the limits. Two versions with the same
 * content are the same measurement, so their digest is the same; a version
 * whose content changed has a different digest, and a score published
 * against the old digest can never be confused with one published against
 * the new.
 *
 * The identity fields (id, timestamps, who created it) are NOT in the
 * digest: they differ between two copies of identical content, and a
 * content address that changes when nothing measured changes is not a
 * content address.
 */
export function computeSuiteVersionDigest(input: {
  suiteId: string;
  version: string;
  schemaVersion?: number;
  taskFamilies?: string[];
  capabilityDomains?: string[];
  difficulty?: Difficulty;
  evaluationProtocol?: EvaluationProtocol;
  scoringRules?: Record<string, unknown>;
  testFixtures?: Record<string, unknown>;
  requiredTools?: unknown[];
  runtimeConstraints?: Record<string, unknown>;
  safetyRequirements?: Record<string, unknown>;
  expectedArtifacts?: unknown[];
  validationRules?: Record<string, unknown>;
  knownLimitations?: string;
}): string {
  return hashCanonical({
    suiteId: input.suiteId,
    version: input.version,
    schemaVersion: input.schemaVersion ?? 1,
    taskFamilies: input.taskFamilies ?? [],
    capabilityDomains: input.capabilityDomains ?? [],
    difficulty: input.difficulty ?? "unknown",
    evaluationProtocol: input.evaluationProtocol ?? "deterministic",
    scoringRules: input.scoringRules ?? {},
    testFixtures: input.testFixtures ?? {},
    requiredTools: input.requiredTools ?? [],
    runtimeConstraints: input.runtimeConstraints ?? {},
    safetyRequirements: input.safetyRequirements ?? {},
    expectedArtifacts: input.expectedArtifacts ?? [],
    validationRules: input.validationRules ?? {},
    knownLimitations: input.knownLimitations ?? "",
  });
}

export function createSuiteVersion(
  input: CreateSuiteVersionInput,
  specDigest?: string,
): SuiteVersion {
  const errors = validateCreateSuiteVersionInput(input);
  if (errors.length > 0) {
    throw new Error(`Invalid suite version input: ${errors.join("; ")}`);
  }

  // Verify suite exists
  const suite = store.suites.get(input.suiteId);
  if (!suite) {
    throw new Error(`Suite "${input.suiteId}" not found`);
  }

  // Check for duplicate version
  for (const [, sv] of store.suiteVersions) {
    if (sv.suiteId === input.suiteId && sv.version === input.version) {
      throw new Error(`Version "${input.version}" already exists for suite "${input.suiteId}"`);
    }
  }

  const now = Date.now();
  const id = randomUUID();

  // A caller may pin a digest; anything that is not a non-empty string is
  // not a digest, and a version whose "digest" is, say, a principal object
  // would be a card that lies about what was measured. Compute one instead.
  const digest =
    typeof specDigest === "string" && specDigest.length > 0
      ? specDigest
      : computeSuiteVersionDigest(input);

  const version: SuiteVersion = {
    id,
    suiteId: input.suiteId,
    version: input.version,
    schemaVersion: input.schemaVersion ?? 1,
    taskFamilies: input.taskFamilies ?? [],
    capabilityDomains: input.capabilityDomains ?? [],
    difficulty: input.difficulty ?? "unknown",
    evaluationProtocol: input.evaluationProtocol ?? "deterministic",
    scoringRules: input.scoringRules ?? {},
    testFixtures: input.testFixtures ?? {},
    requiredTools: input.requiredTools ?? [],
    runtimeConstraints: input.runtimeConstraints ?? {},
    safetyRequirements: input.safetyRequirements ?? {},
    expectedArtifacts: input.expectedArtifacts ?? [],
    validationRules: input.validationRules ?? {},
    knownLimitations: input.knownLimitations ?? "",
    changelog: input.changelog ?? "",
    specDigest: digest,
    publishedAt: suite.status === "PUBLISHED" ? now : null,
    createdAt: now,
  };

  store.suiteVersions.set(id, version);
  return version;
}

export function getSuiteVersion(id: string): SuiteVersion | undefined {
  return store.suiteVersions.get(id);
}

export function getSuiteVersions(suiteId: string): SuiteVersion[] {
  const versions: SuiteVersion[] = [];
  for (const [, sv] of store.suiteVersions) {
    if (sv.suiteId === suiteId) {
      versions.push(sv);
    }
  }
  return versions.sort((a, b) => a.version.localeCompare(b.version));
}

export function getLatestSuiteVersion(suiteId: string): SuiteVersion | undefined {
  const versions = getSuiteVersions(suiteId);
  return versions.length > 0 ? versions[versions.length - 1] : undefined;
}

/* ------------------------------------------------------------------ */
/* Adversarial test operations                                        */
/* ------------------------------------------------------------------ */

export function createAdversarialTest(input: CreateAdversarialTestInput): AdversarialTest {
  const errors = validateCreateAdversarialTestInput(input);
  if (errors.length > 0) {
    throw new Error(`Invalid adversarial test input: ${errors.join("; ")}`);
  }

  // Verify suite version exists
  const suiteVersion = store.suiteVersions.get(input.suiteVersionId);
  if (!suiteVersion) {
    throw new Error(`Suite version "${input.suiteVersionId}" not found`);
  }

  // Check for duplicate name within the same suite version
  for (const [, test] of store.adversarialTests) {
    if (test.suiteVersionId === input.suiteVersionId && test.name === input.name) {
      throw new Error(
        `Adversarial test "${input.name}" already exists for suite version "${input.suiteVersionId}"`,
      );
    }
  }

  const now = Date.now();
  const id = randomUUID();

  const test: AdversarialTest = {
    id,
    suiteVersionId: input.suiteVersionId,
    name: input.name.trim(),
    category: input.category,
    objective: input.objective.trim(),
    threatModel: input.threatModel.trim(),
    expectedBehavior: input.expectedBehavior.trim(),
    detectionCriteria: input.detectionCriteria,
    evidenceRequirements: input.evidenceRequirements,
    testConfig: input.testConfig ?? {},
    severity: input.severity ?? "medium",
    createdAt: now,
  };

  store.adversarialTests.set(id, test);
  return test;
}

export function getAdversarialTest(id: string): AdversarialTest | undefined {
  return store.adversarialTests.get(id);
}

export function getAdversarialTestsForSuiteVersion(
  suiteVersionId: string,
  filters: { category?: AdversarialTestCategory; severity?: AdversarialTestSeverity } = {},
): AdversarialTest[] {
  const tests: AdversarialTest[] = [];

  for (const [, test] of store.adversarialTests) {
    if (test.suiteVersionId !== suiteVersionId) continue;
    if (filters.category && test.category !== filters.category) continue;
    if (filters.severity && test.severity !== filters.severity) continue;
    tests.push(test);
  }

  return tests;
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function getSuiteStore(): SuiteStore {
  return store;
}

export function resetSuiteStore(): void {
  store.suites.clear();
  store.suiteVersions.clear();
  store.adversarialTests.clear();
  store.nextId = 1;
}
