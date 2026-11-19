/**
 * @file workload-software.ts — Phase 1 Software Engineering adapter (WP1-WP3).
 *
 * The deterministic verifier pipeline (§3.5), in the order the blueprint gives
 * it: task integrity, baseline reproduction, patch integrity, build, public
 * checks, hidden regression (in a separate evaluator context), differential
 * checks, security checks, performance, artifact verification, scoring, review.
 *
 * The adapter runs none of those itself. ForgeRunner does, in a sandbox with no
 * network, and reports one observation per check. This module's job is to state
 * which checks the pipeline requires and what passing means, then hand the
 * runner's observations to the shared verdict function. That split is what lets
 * a check fail: the adapter cannot hard-code `true` for a check it never ran.
 */

import type {
  CheckResult,
  ExecutionResult,
  PreparedTask,
  RunContext,
  Scorecard,
  ValidationReport,
  VerificationReport,
  VersionedRubric,
  WorkloadAdapter,
} from "./workload-contracts.js";
import { validateManifest } from "./workload-contracts.js";
import {
  HARD_GATE_DIMENSIONS,
  computeVerdict,
  scoreVerdict,
  type CheckEvidence,
  type RequiredCheck,
} from "./verification.js";
import { validatePatchPolicy } from "./patch-policy.js";

export interface EngineeringTaskPackage {
  slug: string;
  version: string;
  repositorySnapshot: string;
  baseCommit: string;
  baselineCommand: string[];
  expectedExitCode: number;
  checks: { id: string; required: boolean }[];
  rubricId: string;
  /** `regression_repair`, `feature_acceptance`, `refactor`, `reliability`, `contract_detect`, `contract_patch`. */
  mode?: string;
  /** Paths the patch may touch. A patch outside them is a forbidden diff. */
  allowedPaths?: string[];
  /** Paths the patch may never touch (harness, evaluator, tests). */
  forbiddenPaths?: string[];
  /** The feature-acceptance family owns its suite; every other mode does not. */
  allowTestEdits?: boolean;
  /** The pinned runner image digest; a float tag is refused. */
  runnerImageDigest?: string;
  /** The hidden-test bundle commitment, published before the task opens. */
  hiddenTestsCommitment?: string;
  resources?: { cpu?: number; memoryMiB?: number; timeoutSeconds?: number };
  network?: "deny" | "allowlist";
}

export const ENGINEERING_RUBRIC: VersionedRubric = {
  id: "engineering-regression",
  version: "v1",
  dimensions: [
    { id: "acceptance_correctness", weight: 0.35 },
    { id: "regression_resistance", weight: 0.25 },
    { id: "security_invariant", weight: 0.15 },
    { id: "reliability", weight: 0.10 },
    { id: "performance", weight: 0.10 },
    { id: "patch_quality", weight: 0.05 },
  ],
};

/**
 * The pipeline as a list of requirements.
 *
 * Each entry names the dimension it feeds, so scoring is a projection of the
 * evidence rather than a second, separate guess at how good the patch was.
 */
export const ENGINEERING_REQUIREMENTS: readonly RequiredCheck[] = [
  {
    id: "task_integrity",
    required: true,
    dimension: "acceptance_correctness",
    expectation: "task digest, repository snapshot and runner image match the pinned values",
  },
  {
    id: "baseline_reproduction",
    required: true,
    dimension: "acceptance_correctness",
    expectation: "the supplied defect reproduces: the baseline fails for the intended reason",
  },
  {
    id: "patch_integrity",
    required: true,
    dimension: "patch_quality",
    expectation: "the patch stays inside allowed paths and does not touch the harness or tests",
  },
  {
    id: "forbidden_diff",
    required: true,
    dimension: "patch_quality",
    expectation: "no test deletion, skip, assertion weakening or fixture-only hard-coding",
  },
  {
    id: "build",
    required: true,
    dimension: "acceptance_correctness",
    expectation: "a clean build with the pinned toolchain",
  },
  {
    id: "public_regression",
    required: true,
    dimension: "acceptance_correctness",
    expectation: "the visible test suite passes",
  },
  {
    id: "hidden_regression",
    required: true,
    dimension: "regression_resistance",
    expectation: "the hidden suite passes in an isolated evaluator context",
  },
  {
    id: "differential",
    required: false,
    dimension: "regression_resistance",
    expectation: "behaviour matches the reference on generated inputs",
  },
  {
    id: "security_invariant",
    required: true,
    dimension: "security_invariant",
    expectation: "static and policy checks find no invariant violation",
  },
  {
    id: "reliability",
    required: false,
    dimension: "reliability",
    expectation: "retry, concurrency and failure-injection checks pass",
  },
  {
    id: "performance",
    required: false,
    dimension: "performance",
    expectation: "runtime and memory stay inside the declared budget",
  },
  {
    id: "artifact_verified",
    required: true,
    dimension: "patch_quality",
    expectation: "the patch and log digests can be re-fetched and re-hashed",
  },
];

export function validateEngineeringTask(task: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = task as Partial<EngineeringTaskPackage>;
  if (!t.slug) errors.push("slug required");
  if (!t.version) errors.push("version required");
  if (!t.repositorySnapshot) errors.push("repositorySnapshot digest required");
  else if (!/^sha256:[0-9a-f]{64}$/i.test(t.repositorySnapshot)) {
    errors.push("repositorySnapshot must be a sha256:<hex> digest, not a placeholder");
  }
  if (!t.baseCommit) errors.push("baseCommit required");
  if (!Array.isArray(t.baselineCommand) || t.baselineCommand.length === 0) {
    errors.push("baselineCommand required");
  }
  if (typeof t.expectedExitCode !== "number") errors.push("expectedExitCode required");
  if (!Array.isArray(t.checks) || t.checks.length === 0) errors.push("checks required");
  for (const required of [
    "baseline_reproduction",
    "public_regression",
    "hidden_regression",
    "forbidden_diff",
  ] as const) {
    if (!t.checks?.some((c) => c.id === required)) errors.push(`required check missing: ${required}`);
  }
  if (t.runnerImageDigest && !/@sha256:[0-9a-f]{64}$/i.test(t.runnerImageDigest)) {
    errors.push("runnerImageDigest must be a pinned @sha256 digest, not a floating tag");
  }
  if (t.hiddenTestsCommitment && !/^sha256:[0-9a-f]{64}$/i.test(t.hiddenTestsCommitment)) {
    errors.push("hiddenTestsCommitment must be a sha256:<hex> digest");
  }
  // The declared scope is checked here, at publication, rather than only when a
  // patch arrives: a policy of `../..` reads like a restriction and enforces
  // nothing, and the author is the person who can still fix it.
  errors.push(
    ...validatePatchPolicy({
      allowedPaths: t.allowedPaths,
      forbiddenPaths: t.forbiddenPaths,
      allowTestEdits: t.allowTestEdits,
    }),
  );
  if (t.allowedPaths === undefined && t.forbiddenPaths === undefined) {
    warnings.push(
      "no patch scope declared: only the built-in test/evaluator/harness refusal applies; " +
        "declare allowedPaths so an unrelated-file edit is a policy violation",
    );
  }
  if (t.network === undefined) {
    warnings.push("network policy not declared; the runner will deny egress by default");
  }
  if (t.mode === "exploit_sandbox") {
    warnings.push(
      "exploit tasks must name a local, isolated chain; a public mainnet or testnet target is never allowed",
    );
  }
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * The requirement set for a task mode.
 *
 * The blueprint distinguishes a *defect* from a *finding*: a regression repair's
 * failed security check is a failed trial, while a vulnerability-detection
 * task's failed check is a candidate finding that a human has to confirm before
 * it counts (and before it is worth a bounty). Marking `security_invariant` as
 * review-on-failure is how that distinction reaches the verdict instead of
 * living in a reviewer's inbox.
 *
 * The returned array is fresh: the exported constant is shared, and a caller
 * that mutated it would change every later run in the process.
 */
export function requirementsForMode(mode: string | undefined): readonly RequiredCheck[] {
  if (mode !== "contract_detect") return ENGINEERING_REQUIREMENTS;
  return ENGINEERING_REQUIREMENTS.map((requirement) =>
    requirement.id === "security_invariant" ? { ...requirement, reviewOnFailure: true } : requirement,
  );
}

export class SoftwareEngineeringAdapter implements WorkloadAdapter<EngineeringTaskPackage, string> {
  profile = "SOFTWARE_ENGINEERING" as const;
  version = "software-engineering/1.1.0";

  async validateTask(task: unknown): Promise<ValidationReport> {
    return validateEngineeringTask(task);
  }

  async prepare(input: EngineeringTaskPackage, context: RunContext): Promise<PreparedTask> {
    const v = validateEngineeringTask(input);
    if (!v.valid) throw new Error(`invalid task: ${v.errors.join("; ")}`);
    const manifest = {
      runId: context.runId,
      attemptId: context.attemptId,
      tenantId: context.tenantId,
      trialId: context.trialId,
      trialRevisionId: context.trialRevisionId,
      workloadProfile: this.profile,
      adapterVersion: this.version,
      taskDigest: input.repositorySnapshot,
      // The task's pinned image wins over the run context's environment digest:
      // a run that picks its own image is not reproducible.
      runnerImageDigest: input.runnerImageDigest ?? context.environmentDigest,
      evaluatorVersion: "evaluator/1.1.0",
      rubricVersion: `${ENGINEERING_RUBRIC.id}/${ENGINEERING_RUBRIC.version}`,
      startedAt: Date.now(),
      artifactDigests: [] as string[],
    };
    const errs = validateManifest(manifest);
    if (errs.length) throw new Error(`manifest invalid: ${errs.join("; ")}`);
    return { taskDigest: input.repositorySnapshot, manifest, requirements: requirementsForMode(input.mode) };
  }

  async execute(prepared: PreparedTask, _context: RunContext): Promise<ExecutionResult> {
    // Real execution happens in ForgeRunner's sandbox. This adapter cannot run
    // a repository test suite, and pretending it did is how a verifier becomes
    // decoration: no evidence is reported here, so `verify` below says
    // EVIDENCE_INCOMPLETE until a runner actually reports some.
    return {
      artifacts: [],
      logs: [`adapter:delegated-to-forge-runner task=${prepared.taskDigest}`],
      outcome: "completed",
      // The requirement set the task was prepared under travels with the run, so
      // the verdict cannot be computed against a different mode than the one the
      // runner executed.
      requirements: prepared.requirements,
    };
  }

  async verify(result: ExecutionResult, _context: RunContext): Promise<VerificationReport> {
    const verdict = computeVerdict({
      requirements: result.requirements ?? ENGINEERING_REQUIREMENTS,
      evidence: result.evidence as CheckEvidence[] | undefined,
      outcome: result.outcome,
      infrastructureFailure: result.infrastructureFailure,
      verifierVersion: this.version,
    });
    return verdict.report;
  }

  async score(report: VerificationReport, rubric: VersionedRubric): Promise<Scorecard> {
    return scoreVerdict({
      report,
      rubric,
      requirements: ENGINEERING_REQUIREMENTS,
      hardGateDimensions: HARD_GATE_DIMENSIONS.software,
    }).scorecard;
  }

  async cleanup(_context: RunContext): Promise<void> {
    // The sandbox workspace is ephemeral and removed by ForgeRunner.
  }
}

export const softwareEngineeringAdapter = new SoftwareEngineeringAdapter();

/** Exported for the console's check list and for tests. */
export function engineeringCheckIds(): string[] {
  return ENGINEERING_REQUIREMENTS.map((r) => r.id);
}

/** A report is a pass only when every required check passed with evidence. */
export function isEngineeringPass(report: VerificationReport): boolean {
  return report.status === "PASS";
}

export type { CheckResult };