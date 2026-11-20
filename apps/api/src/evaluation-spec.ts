/**
 * @file evaluation-spec.ts — Evaluation specification generation (Phase 2).
 *
 * Generates machine-readable evaluation specifications from suite version,
 * agent identity, and environment configuration. Published specs are immutable
 * — changes create new revisions, matching the trial revision pattern.
 */

import { createHash, randomUUID } from "node:crypto";
import { getSuite, getSuiteVersion, getSuiteVersions } from "./suites.js";
import type { EvaluationProtocol } from "./suites.js";
import { ALL_DIMENSIONS, DEFAULT_DIMENSION_WEIGHTS, type ScoreDimension } from "./scoring.js";
import { DEFAULT_REPETITION_POLICY } from "./replay-policy.js";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type SpecStatus = "DRAFT" | "PUBLISHED" | "EXECUTING" | "COMPLETED" | "ARCHIVED";
export type PublicationPolicy = "private" | "org" | "public";

export interface FixtureRef {
  fixtureId: string;
  hash: string;
  path?: string;
}

export interface ExecutionEnvironment {
  runtimeImage: string;
  cpuLimit?: number;
  memoryLimitMb?: number;
  timeLimitSeconds?: number;
  networkEgress?: boolean;
  filesystemRestrictions?: string[];
}

export interface JudgeConfig {
  judgeVersion: string;
  modelProvider?: string;
  rubricVersion?: string;
}

export interface ScoringDimension {
  /**
   * The dimension's name.
   *
   * This is the SCORING ENGINE's type, not a second union of the same five
   * names. A copy of the list is a rename that leaves half the platform
   * scoring dimensions the other half has never heard of.
   */
  name: ScoreDimension;
  weight: number;
}

export interface ScoringMethodology {
  dimensions: ScoringDimension[];
  aggregateMethod?: "weighted_average" | "min_max" | "custom";
}

export interface RepetitionPolicy {
  repetitions?: number;
  independentReplays?: number;
}

export interface RandomnessConfig {
  mode: "deterministic" | "vrf";
  seed?: string;
  vrfRequestId?: string;
}

export interface EvaluationSpec {
  specId: string;
  trialId: string;
  trialRevision: number;
  suiteVersionId: string;
  suiteId: string;
  suiteVersion: string;
  agentId: string;
  agentVersion?: string;
  modelId?: string;
  providerConfig?: Record<string, unknown>;
  evaluationProtocol: EvaluationProtocol;
  taskCategory?: string;
  taskSpecification?: Record<string, unknown>;
  inputFixtures: FixtureRef[];
  hiddenTestDefinitions?: unknown[];
  executionEnvironment: ExecutionEnvironment;
  runtimeConfig?: Record<string, unknown>;
  resourceLimits?: Record<string, unknown>;
  toolPermissions?: Record<string, unknown>;
  judgeConfig: JudgeConfig;
  scoringMethodology: ScoringMethodology;
  repetitionPolicy: RepetitionPolicy;
  randomnessConfig: RandomnessConfig;
  evidenceRequirements?: Record<string, unknown>;
  publicationPolicy: PublicationPolicy;
  disputeRules?: Record<string, unknown>;
  rewardTerms?: Record<string, unknown>;
  specDigest: string;
  status: SpecStatus;
  schemaVersion: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEvaluationSpecInput {
  trialId: string;
  trialRevision?: number;
  suiteId: string;
  suiteVersion?: string;
  agentId: string;
  agentVersion?: string;
  modelId?: string;
  providerConfig?: Record<string, unknown>;
  evaluationProtocol?: EvaluationProtocol;
  taskCategory?: string;
  taskSpecification?: Record<string, unknown>;
  inputFixtures?: FixtureRef[];
  hiddenTestDefinitions?: unknown[];
  executionEnvironment: ExecutionEnvironment;
  runtimeConfig?: Record<string, unknown>;
  resourceLimits?: Record<string, unknown>;
  toolPermissions?: Record<string, unknown>;
  judgeConfig?: JudgeConfig;
  scoringMethodology?: ScoringMethodology;
  repetitionPolicy?: RepetitionPolicy;
  randomnessConfig?: RandomnessConfig;
  evidenceRequirements?: Record<string, unknown>;
  publicationPolicy?: PublicationPolicy;
  disputeRules?: Record<string, unknown>;
  rewardTerms?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

/**
 * The valid dimensions.
 *
 * Built from the scoring engine's list, so a dimension the engine knows and
 * this validator does not — or the reverse — cannot happen.
 */
const VALID_DIMENSIONS = new Set<string>(ALL_DIMENSIONS);

function validateScoringMethodology(
  methodology: ScoringMethodology,
): string[] {
  const errors: string[] = [];

  if (!methodology.dimensions || methodology.dimensions.length === 0) {
    errors.push("scoring methodology must have at least one dimension");
    return errors;
  }

  let totalWeight = 0;
  for (const dim of methodology.dimensions) {
    if (!VALID_DIMENSIONS.has(dim.name)) {
      errors.push(`unknown dimension: ${dim.name}`);
    }
    if (dim.weight < 0 || dim.weight > 1) {
      errors.push(`dimension ${dim.name} weight must be in [0, 1]`);
    }
    totalWeight += dim.weight;
  }

  if (Math.abs(totalWeight - 1.0) > 0.001) {
    errors.push(`dimension weights must sum to 1.0 (got ${totalWeight})`);
  }

  return errors;
}

function validateExecutionEnvironment(
  env: ExecutionEnvironment,
): string[] {
  const errors: string[] = [];

  if (!env.runtimeImage) {
    errors.push("runtimeImage is required for reproducible execution");
  }

  if (env.cpuLimit !== undefined && env.cpuLimit < 1) {
    errors.push("cpuLimit must be >= 1");
  }

  if (env.memoryLimitMb !== undefined && env.memoryLimitMb < 64) {
    errors.push("memoryLimitMb must be >= 64");
  }

  if (env.timeLimitSeconds !== undefined && env.timeLimitSeconds < 1) {
    errors.push("timeLimitSeconds must be >= 1");
  }

  return errors;
}

function validateJudgeConfig(config: JudgeConfig): string[] {
  const errors: string[] = [];
  if (!config.judgeVersion) {
    errors.push("judgeVersion is required for version-pinned judging");
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Digest calculation                                                 */
/* ------------------------------------------------------------------ */

export function computeSpecDigest(spec: EvaluationSpec): string {
  const canonical = {
    spec_id: spec.specId,
    trial_id: spec.trialId,
    trial_revision: spec.trialRevision,
    suite_version_id: spec.suiteVersionId,
    agent_id: spec.agentId,
    agent_version: spec.agentVersion,
    model_id: spec.modelId,
    evaluation_protocol: spec.evaluationProtocol,
    task_category: spec.taskCategory,
    task_specification: spec.taskSpecification,
    input_fixtures: spec.inputFixtures,
    execution_environment: spec.executionEnvironment,
    runtime_config: spec.runtimeConfig,
    resource_limits: spec.resourceLimits,
    tool_permissions: spec.toolPermissions,
    judge_config: spec.judgeConfig,
    scoring_methodology: spec.scoringMethodology,
    repetition_policy: spec.repetitionPolicy,
    randomness_config: spec.randomnessConfig,
    evidence_requirements: spec.evidenceRequirements,
    publication_policy: spec.publicationPolicy,
    dispute_rules: spec.disputeRules,
    schema_version: spec.schemaVersion,
  };

  const canonicalJson = JSON.stringify(canonical, (_, value) =>
    typeof value === "undefined" ? null : value,
  );

  return createHash("sha256").update(canonicalJson).digest("hex");
}

/* ------------------------------------------------------------------ */
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

interface SpecStore {
  specs: Map<string, EvaluationSpec>;
}

const store: SpecStore = { specs: new Map() };

/* ------------------------------------------------------------------ */
/* Defaults                                                           */
/* ------------------------------------------------------------------ */

/*
 * The default scoring methodology names the same dimensions the scoring
 * engine scores, and gives them their default weights — so it is BUILT from
 * the scoring engine's own list rather than repeating it. A second copy of
 * the dimension names is a rename that leaves half the platform scoring
 * dimensions the other half has never heard of.
 */
const DEFAULT_SCORING_METHODOLOGY: ScoringMethodology = {
  dimensions: ALL_DIMENSIONS.map((name) => ({
    name,
    weight: DEFAULT_DIMENSION_WEIGHTS[name],
  })),
  aggregateMethod: "weighted_average",
};

const DEFAULT_RANDOMNESS_CONFIG: RandomnessConfig = {
  mode: "deterministic",
};

/* ------------------------------------------------------------------ */
/* Spec generation                                                    */
/* ------------------------------------------------------------------ */

export function generateEvaluationSpec(
  input: CreateEvaluationSpecInput,
): EvaluationSpec {
  const errors: string[] = [];

  if (!input.trialId) errors.push("trialId is required");
  if (!input.suiteId) errors.push("suiteId is required");
  if (!input.agentId) errors.push("agentId is required");

  if (errors.length > 0) {
    throw new Error(`Invalid spec input: ${errors.join("; ")}`);
  }

  const suite = getSuite(input.suiteId);
  if (!suite) {
    throw new Error(`Suite "${input.suiteId}" not found`);
  }

  // Find the requested suite version or use the latest
  let suiteVersion = getSuiteVersion(input.suiteVersion ?? "");
  if (!suiteVersion) {
    const versions = getSuiteVersions(input.suiteId);
    if (input.suiteVersion) {
      suiteVersion = versions.find((v: { version: string }) => v.version === input.suiteVersion);
    } else {
      suiteVersion = versions[versions.length - 1];
    }
  }

  if (!suiteVersion) {
    throw new Error(
      `No suite version found for suite "${input.suiteId}" version "${input.suiteVersion ?? "latest"}"`,
    );
  }

  const envErrors = validateExecutionEnvironment(input.executionEnvironment);
  errors.push(...envErrors);

  const methodology = input.scoringMethodology ?? DEFAULT_SCORING_METHODOLOGY;
  const methodErrors = validateScoringMethodology(methodology);
  errors.push(...methodErrors);

  const judgeConfig = input.judgeConfig ?? {
    judgeVersion: "1",
    rubricVersion: methodology.dimensions[0]?.name ?? "CORRECTNESS",
  };
  const judgeErrors = validateJudgeConfig(judgeConfig);
  errors.push(...judgeErrors);

  if (errors.length > 0) {
    throw new Error(`Invalid spec configuration: ${errors.join("; ")}`);
  }

  const protocol = input.evaluationProtocol ?? suiteVersion.evaluationProtocol;

  const inputFixtures = input.inputFixtures ?? [];

  const now = Date.now();
  const specId = randomUUID();

  const spec: EvaluationSpec = {
    specId,
    trialId: input.trialId,
    trialRevision: input.trialRevision ?? 1,
    suiteVersionId: suiteVersion.id,
    suiteId: input.suiteId,
    suiteVersion: suiteVersion.version,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    modelId: input.modelId,
    providerConfig: input.providerConfig,
    evaluationProtocol: protocol,
    taskCategory: input.taskCategory ?? suiteVersion.taskFamilies[0],
    taskSpecification: input.taskSpecification,
    inputFixtures,
    hiddenTestDefinitions: input.hiddenTestDefinitions,
    executionEnvironment: input.executionEnvironment,
    runtimeConfig: input.runtimeConfig,
    resourceLimits: input.resourceLimits,
    toolPermissions: input.toolPermissions,
    judgeConfig,
    scoringMethodology: methodology,
    repetitionPolicy: input.repetitionPolicy ?? DEFAULT_REPETITION_POLICY,
    randomnessConfig: input.randomnessConfig ?? DEFAULT_RANDOMNESS_CONFIG,
    evidenceRequirements: input.evidenceRequirements,
    publicationPolicy: input.publicationPolicy ?? "private",
    disputeRules: input.disputeRules,
    rewardTerms: input.rewardTerms,
    specDigest: "",
    status: "DRAFT",
    schemaVersion: "1.0.0",
    createdAt: now,
    updatedAt: now,
  };

  spec.specDigest = computeSpecDigest(spec);
  store.specs.set(specId, spec);

  return spec;
}

export function publishSpec(specId: string): EvaluationSpec {
  const spec = store.specs.get(specId);
  if (!spec) {
    throw new Error(`Spec "${specId}" not found`);
  }
  if (spec.status !== "DRAFT") {
    throw new Error(`Spec "${specId}" is ${spec.status}, cannot publish`);
  }

  const now = Date.now();
  const published = { ...spec, status: "PUBLISHED" as const, updatedAt: now };
  store.specs.set(specId, published);
  return published;
}

export function getEvaluationSpec(specId: string): EvaluationSpec | undefined {
  return store.specs.get(specId);
}

export function listSpecsByTrial(trialId: string): EvaluationSpec[] {
  const specs: EvaluationSpec[] = [];
  for (const [, spec] of store.specs) {
    if (spec.trialId === trialId) specs.push(spec);
  }
  return specs;
}

export function listSpecsBySuite(suiteId: string): EvaluationSpec[] {
  const specs: EvaluationSpec[] = [];
  for (const [, spec] of store.specs) {
    if (spec.suiteId === suiteId) specs.push(spec);
  }
  return specs;
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function getSpecStore(): SpecStore {
  return store;
}

export function resetSpecStore(): void {
  store.specs.clear();
}
