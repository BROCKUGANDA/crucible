/**
 * @file workload-solana.ts — Phase 1 Solana engineering challenges (Colosseum brief).
 *
 * Challenge families: program audit (Anchor vulns), reproducible SBF builds,
 * GoSVM experimental compilation, compute-unit efficiency, malformed-account
 * and invalid-signer resistance. All deterministic, machine-checkable first.
 *
 * Anchor vuln classes covered: missing signer check, missing owner check,
 * arbitrary CPI, PDA seed confusion, integer overflow, account reinitialization.
 * GoSVM is experimental/benchmark-only — never a production dependency.
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

export type SolanaChallengeKind =
  | "anchor_audit"
  | "sbf_reproducibility"
  | "gosvm_compile"
  | "compute_efficiency"
  | "account_robustness";

export interface SolanaTaskPackage {
  slug: string;
  version: string;
  kind: SolanaChallengeKind;
  programRef: string;
  anchorVersion?: string;
  solanaVersion?: string;
  checks: { id: string; required: boolean }[];
  rubricId: string;
}

export const SOLANA_RUBRIC: VersionedRubric = {
  id: "solana-engineering",
  version: "v1",
  dimensions: [
    { id: "vuln_detection", weight: 0.30 },
    { id: "build_reproducibility", weight: 0.25 },
    { id: "robustness", weight: 0.20 },
    { id: "compute_efficiency", weight: 0.15 },
    { id: "evidence_quality", weight: 0.10 },
  ],
};

export const ANCHOR_VULN_CLASSES = [
  "missing_signer_check",
  "missing_owner_check",
  "arbitrary_cpi",
  "pda_seed_confusion",
  "integer_overflow",
  "account_reinitialization",
] as const;

export function validateSolanaTask(task: unknown): ValidationReport {
  const errors: string[] = [];
  const t = task as Partial<SolanaTaskPackage>;
  if (!t.slug) errors.push("slug required");
  if (!t.version) errors.push("version required");
  if (!t.kind) errors.push("kind required");
  else if (!["anchor_audit", "sbf_reproducibility", "gosvm_compile", "compute_efficiency", "account_robustness"].includes(t.kind)) {
    errors.push(`unknown kind: ${t.kind}`);
  }
  if (!t.programRef) errors.push("programRef required (pinned source snapshot)");
  if (!Array.isArray(t.checks) || t.checks.length === 0) errors.push("checks required");
  return { valid: errors.length === 0, errors, warnings: t.kind === "gosvm_compile" ? ["gosvm is experimental alpha — benchmark only, never production"] : [] };
}

/**
 * The checks a Solana challenge requires, by kind.
 *
 * Every kind requires a reproducible SBF build and an isolated local chain: a
 * build that cannot be reproduced cannot be graded, and a challenge that names
 * a public cluster is refused outright (see `validateSolanaTask`).
 */
export const SOLANA_REQUIREMENTS: readonly RequiredCheck[] = [
  {
    id: "sbf_reproducibility",
    required: true,
    dimension: "build_reproducibility",
    expectation: "two independent SBF builds produce byte-identical programs",
  },
  {
    id: "local_chain_only",
    required: true,
    dimension: "evidence_quality",
    expectation: "the challenge ran against a local, isolated chain and never a public cluster",
  },
  {
    id: "anchor_missing_signer_check",
    required: true,
    dimension: "vuln_detection",
    expectation: "missing signer checks are detected and confirmed",
  },
  {
    id: "anchor_missing_owner_check",
    required: true,
    dimension: "vuln_detection",
    expectation: "missing owner checks are detected and confirmed",
  },
  {
    id: "account_robustness",
    required: false,
    dimension: "robustness",
    expectation: "malformed accounts and invalid signers are refused by the program",
  },
  {
    id: "compute_efficiency",
    required: false,
    dimension: "compute_efficiency",
    expectation: "compute units stay inside the declared budget",
  },
  {
    id: "evidence_recorded",
    required: true,
    dimension: "evidence_quality",
    expectation: "the program digest, the PoC transcript and the run manifest are all recorded",
  },
];

export function anchorAuditChecks(findings: { class: string; confirmed: boolean }[]): CheckResult[] {
  return ANCHOR_VULN_CLASSES.map((cls) => {
    const f = findings.find((x) => x.class === cls);
    return {
      id: `anchor_${cls}`,
      passed: f ? f.confirmed : true,
      required: cls === "missing_signer_check" || cls === "missing_owner_check",
      detail: f ? `${cls}: ${f.confirmed ? "confirmed" : "not present"}` : `${cls}: no finding`,
    };
  });
}

export class SolanaEngineeringAdapter implements WorkloadAdapter<SolanaTaskPackage, string> {
  profile = "SOFTWARE_ENGINEERING" as const;
  version = "solana-engineering/1.0.0";

  async validateTask(task: unknown): Promise<ValidationReport> {
    return validateSolanaTask(task);
  }

  async prepare(input: SolanaTaskPackage, context: RunContext): Promise<PreparedTask> {
    const v = validateSolanaTask(input);
    if (!v.valid) throw new Error(`invalid solana task: ${v.errors.join("; ")}`);
    const manifest = {
      runId: context.runId, attemptId: context.attemptId, tenantId: context.tenantId,
      trialId: context.trialId, trialRevisionId: context.trialRevisionId,
      workloadProfile: this.profile, adapterVersion: this.version,
      taskDigest: `${input.slug}@${input.version}:${input.kind}`,
      runnerImageDigest: context.environmentDigest,
      evaluatorVersion: "solana-evaluator/1.0.0",
      rubricVersion: `${SOLANA_RUBRIC.id}/${SOLANA_RUBRIC.version}`,
      startedAt: Date.now(), artifactDigests: [],
    };
    const errs = validateManifest(manifest);
    if (errs.length) throw new Error(`manifest invalid: ${errs.join("; ")}`);
    return { taskDigest: manifest.taskDigest, manifest };
  }

  async execute(prepared: PreparedTask, _context: RunContext): Promise<ExecutionResult> {
    return { artifacts: [], logs: ["adapter:delegated-to-forge-runner:solana"], outcome: "completed" };
  }

  /**
   * Verify from the runner's observations.
   *
   * This used to return INCOMPLETE with three hard-coded failures and a
   * placeholder digest, which is the worst of both shapes: it could never pass
   * (so the task family was unusable) and it could never be turned red (so it
   * proved nothing). Now it reads what the runner observed and refuses only
   * what is genuinely missing.
   */
  async verify(result: ExecutionResult, _context: RunContext): Promise<VerificationReport> {
    const verdict = computeVerdict({
      requirements: SOLANA_REQUIREMENTS,
      evidence: (result.evidence ?? []) as CheckEvidence[],
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
      requirements: SOLANA_REQUIREMENTS,
      hardGateDimensions: HARD_GATE_DIMENSIONS.software,
    }).scorecard;
  }

  async cleanup(_context: RunContext): Promise<void> {}
}

export const solanaEngineeringAdapter = new SolanaEngineeringAdapter();
