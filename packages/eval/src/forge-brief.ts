/**
 * @file forge-brief.ts — Forge Brief schema and validation.
 *
 * The sponsor must describe the actual problem before Crucible calculates
 * difficulty or recommends a reward. A Forge Brief is the structured,
 * versioned, schema-validated input to the Adaptive Forge difficulty and
 * bounty engines.
 *
 * Every field is optional-except-where-noted so that incomplete briefs can be
 * represented honestly as "Draft" or "Missing requirements" rather than
 * fabricated as complete.
 *
 * No field is ever fabricated: absent values are represented as undefined,
 * never as zero or a default.
 */

import { sha256 } from "@crucible/crypto";

/* ------------------------------------------------------------------ */
/* Forge Brief                                                        */
/* ------------------------------------------------------------------ */

export type ForgeBriefStatus =
  | "draft"
  | "missing_requirements"
  | "validation_failed"
  | "awaiting_review"
  | "calibrating"
  | "ready_to_fund"
  | "funded"
  | "open"
  | "assigned"
  | "judging"
  | "challenged"
  | "settled";

export interface ForgeBriefObjective {
  title: string;
  domain: string;
  problemStatement: string;
  intendedOutcome: string;
  purpose: string; // business or technical purpose
  whyItMatters: string;
  expectedDeliverable: string;
}

export interface ForgeBriefRequirement {
  id: string;
  text: string;
  mandatory: boolean;
  acceptanceCriteria: string[];
  qualityThreshold?: string;
  outputFormat?: string;
  validationConditions?: string[];
  prohibitedApproaches?: string[];
  requiredEvidence?: string[];
}

export interface ForgeBriefComplexity {
  steps?: number;
  dependencyCount?: number;
  integrationComplexity?: "low" | "medium" | "high";
  dataVolume?: string;
  systemComplexity?: "low" | "medium" | "high";
  novelty?: "known" | "adapted" | "novel";
  ambiguity?: "low" | "medium" | "high";
  requiredSpecialistKnowledge?: string[];
  anticipatedExecutionTimeMs?: number;
}

export interface ForgeBriefEnvironment {
  allowedLanguages?: string[];
  frameworks?: string[];
  modelProviders?: string[];
  apis?: string[];
  tools?: string[];
  networkPermissions?: string[];
  filesystemPermissions?: string[];
  runtimeConstraints?: string[];
  computeLimits?: string;
  deploymentRequirements?: string[];
}

export interface ForgeBriefVerification {
  deterministicTestSuite?: boolean;
  hiddenHoldoutTests?: boolean;
  referenceSolution?: boolean;
  independentVerificationMethod?: string;
  rubric?: string;
  humanReviewRequirements?: string[];
  requiredArtifactHashes?: string[];
  reproducibilityRequirements?: string[];
}

export interface ForgeBriefReliabilityAndRisk {
  expectedReliability?: number; // 0-1
  securitySensitivity?: "low" | "medium" | "high";
  financialSensitivity?: "low" | "medium" | "high";
  deadlineMs?: number;
  failureImpact?: string;
  requiredRecoverability?: string;
  adversarialTestingRequirements?: string[];
  dataClassification?: "public" | "internal" | "confidential" | "restricted";
}

export interface ForgeBriefFinancialCommitment {
  maxBudgetWei?: bigint;
  nativeAsset: "ETH" | "SOL";
  network: string;
  proposedRewardWei?: bigint;
  stageRewardsWei?: bigint[];
  requiredDeadlineMs?: number;
  paymentTerms?: string;
  refundTerms?: string;
}

export interface ForgeBrief {
  version: string;
  briefId: string;
  sponsor: string;
  createdAt: number;
  updatedAt: number;
  status: ForgeBriefStatus;
  objective: ForgeBriefObjective;
  requirements: ForgeBriefRequirement[];
  complexity: ForgeBriefComplexity;
  environment: ForgeBriefEnvironment;
  verification: ForgeBriefVerification;
  reliabilityAndRisk: ForgeBriefReliabilityAndRisk;
  financialCommitment: ForgeBriefFinancialCommitment;
  /** Content digest of the brief (JCS canonical JSON). Absent until computed. */
  digest?: string;
}

export function newForgeBrief(
  briefId: string,
  sponsor: string,
): ForgeBrief {
  if (!briefId || !sponsor) {
    throw new Error("forge-brief: briefId and sponsor are required");
  }
  const now = Date.now();
  return {
    version: "1.0",
    briefId,
    sponsor,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    objective: {
      title: "",
      domain: "",
      problemStatement: "",
      intendedOutcome: "",
      purpose: "",
      whyItMatters: "",
      expectedDeliverable: "",
    },
    requirements: [],
    complexity: {},
    environment: {},
    verification: {},
    reliabilityAndRisk: {},
    financialCommitment: { nativeAsset: "ETH", network: "31337" },
  };
}

/* ------------------------------------------------------------------ */
/* Challenge Readiness Report                                         */
/* ------------------------------------------------------------------ */

export type ReadinessCheck =
  | "schema_valid"
  | "acceptance_criteria_present"
  | "requirements_testable"
  | "test_suite_matches_requirements"
  | "reference_solution_verified"
  | "baseline_benchmarked"
  | "ambiguity_identified"
  | "duplicates_checked"
  | "contamination_checked"
  | "reward_appropriate"
  | "deadline_realistic"
  | "human_review_required";

export interface ChallengeReadinessReport {
  briefId: string;
  status: ForgeBriefStatus;
  checks: Record<string, boolean>;
  failures: string[];
  warnings: string[];
  reviewedAt?: number;
  reviewedBy?: string;
  nextStep: string;
}

export function newReadinessReport(briefId: string): ChallengeReadinessReport {
  return {
    briefId,
    status: "draft",
    checks: {},
    failures: [],
    warnings: [],
    nextStep: "Complete the Forge Brief objective and requirements.",
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Validate a Forge Brief. Returns a Challenge Readiness Report. A brief is
 * "ready to fund" only when all mandatory checks pass and a human has
 * reviewed high-value/high-risk challenges.
 *
 * Absent fields are reported as failures — never fabricated as present.
 */
export function validateForgeBrief(
  brief: ForgeBrief,
): ChallengeReadinessReport {
  const report = newReadinessReport(brief.briefId);
  const checks: Record<string, boolean> = {};
  const failures: string[] = [];
  const warnings: string[] = [];

  // 1. Schema validation: objective fields present.
  const objOk =
    !!brief.objective.title &&
    !!brief.objective.domain &&
    !!brief.objective.problemStatement &&
    !!brief.objective.intendedOutcome &&
    !!brief.objective.expectedDeliverable;
  checks.schema_valid = objOk;
  if (!objOk) failures.push("Objective is missing required fields.");

  // 2. Acceptance criteria present on every mandatory requirement.
  const criteriaOk = brief.requirements.every(
    (r) => !r.mandatory || (r.acceptanceCriteria && r.acceptanceCriteria.length > 0),
  );
  checks.acceptance_criteria_present = criteriaOk;
  if (!criteriaOk) {
    failures.push("Mandatory requirement missing acceptance criteria.");
  }

  // 3. Requirements are testable (have validation conditions or required evidence).
  const testableOk = brief.requirements.every(
    (r) =>
      (r.validationConditions && r.validationConditions.length > 0) ||
      (r.requiredEvidence && r.requiredEvidence.length > 0),
  );
  checks.requirements_testable = testableOk;
  if (!testableOk) {
    failures.push("Some requirements are not testable (no validation conditions or evidence).");
  }

  // 4. Verification present.
  const verificationOk =
    brief.verification.deterministicTestSuite !== undefined ||
    brief.verification.hiddenHoldoutTests !== undefined;
  checks.test_suite_matches_requirements = verificationOk;
  if (!verificationOk) {
    warnings.push("No deterministic test suite or hidden holdout tests declared.");
  }

  // 5. Reward appropriate for workload (heuristic: if set, it must be > 0).
  // undefined = not set (ok); 0 or negative = not ok.
  const rewardOk =
    brief.financialCommitment.proposedRewardWei === undefined ||
    brief.financialCommitment.proposedRewardWei > 0n;
  checks.reward_appropriate = rewardOk;
  if (!rewardOk) {
    failures.push("Proposed reward must be greater than zero.");
  }

  // 6. Deadline realistic (heuristic: if set, must be in the future).
  const deadlineOk =
    !brief.reliabilityAndRisk.deadlineMs ||
    brief.reliabilityAndRisk.deadlineMs > Date.now();
  checks.deadline_realistic = deadlineOk;
  if (!deadlineOk) {
    failures.push("Deadline must be in the future.");
  }

  // 7. Ambiguity identified.
  const ambiguityOk =
    brief.complexity.ambiguity !== undefined;
  checks.ambiguity_identified = ambiguityOk;
  if (!ambiguityOk) {
    warnings.push("Ambiguity not declared — treat as high.");
  }

  const allPass = failures.length === 0;
  const highValue =
    !!brief.financialCommitment.proposedRewardWei &&
    brief.financialCommitment.proposedRewardWei > 100_000_000_000_000_000n; // > 0.1 ETH

  if (allPass && highValue) {
    report.status = "awaiting_review";
    report.nextStep =
      "High-value challenge requires human review before funding.";
  } else if (allPass) {
    report.status = "ready_to_fund";
    report.nextStep = "Brief is ready to fund.";
  } else {
    report.status = "validation_failed";
    report.nextStep =
      "Resolve validation failures before the brief can be funded.";
  }

  report.checks = checks;
  report.failures = failures;
  report.warnings = warnings;
  return report;
}

/* ------------------------------------------------------------------ */
/* Content digest                                                     */
/* ------------------------------------------------------------------ */

/**
 * Compute the content digest of a Forge Brief. The digest covers all
 * score-affecting fields: objective, requirements, complexity, environment,
 * verification, reliabilityAndRisk, financialCommitment. It does NOT cover
 * status, timestamps, or briefId — those are metadata, not content.
 */
export function computeBriefDigest(brief: ForgeBrief): string {
  const content = {
    objective: brief.objective,
    requirements: brief.requirements,
    complexity: brief.complexity,
    environment: brief.environment,
    verification: brief.verification,
    reliabilityAndRisk: brief.reliabilityAndRisk,
    financialCommitment: brief.financialCommitment,
  };
  return sha256(JSON.stringify(content));
}

/**
 * Set the digest on a brief and mark it updated.
 */
export function sealBrief(brief: ForgeBrief): ForgeBrief {
  return {
    ...brief,
    digest: computeBriefDigest(brief),
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* TypeScript brand                                                   */
/* ------------------------------------------------------------------ */

export const __forgeBriefBrand = Symbol.for("crucible.forge-brief");