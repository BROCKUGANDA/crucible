import { buildEvalManifest, manifestDigest, type EvalManifest } from "@crucible/smith";
import type { Hex } from "viem";
import { resolveVerifierImage, type SandboxSpec } from "./sandbox.js";
import type { TrialTier } from "./tiers.js";

/**
 * The manifest a run emits beside its artifact.
 *
 * The artifact says what the agent produced; this says what was evaluated.
 * Without it, two runs of the same model against the same suite differ in a
 * way nobody can attribute - the model changed, or the rubric did, or the
 * harness did, or the temperature did.
 *
 * **It is emitted, not derived from the artifact.** The artifact is the
 * runner's signed attestation and everything in it is a fact about the *run*.
 * The manifest is a fact about the *evaluation*, and it is hashed rather
 * than signed - nobody needs to vouch for it, because every input in it is
 * itself content-addressed (ADR-0017).
 *
 * **Nothing on chain changes.** The manifest travels with the run's result
 * and is fetchable by digest, the way a spec is. `computeRunHash` and
 * `submitRun` are untouched.
 *
 * **The split of knowledge is the design.** The *operator* knows the trial's
 * on-chain commitments, the evaluator version and the rubric - it posted the
 * trial. The *runner* knows the environment it executed in and when. Neither
 * side can supply the other's facts, and a manifest that guessed the other
 * side's would be worse than one that is silent about it.
 */

/**
 * The facts only the operator knows.
 *
 * These are the trial's on-chain commitments and the evaluation's policy.
 * The operator posted the trial, so it knows what the chain holds; the
 * runner does not, and must not re-derive it.
 */
export interface ManifestInputs {
  /** The trial's spec commitment - the bytes32 the chain holds. */
  specDigest: Hex;
  /** The trial's suite commitment - the bytes32 the chain holds. */
  suiteDigest: Hex;
  /** The dataset the task used, when it used one. */
  datasetDigest?: Hex;
  /** The provider that served the model. */
  provider: string;
  /** The model name as the provider reports it. */
  model: string;
  /** The exact model version or snapshot. A moving alias is refused. */
  modelVersion: string;
  /** The seed for every stochastic component. */
  seed: string;
  /** Sampling parameters, as exact decimal text. */
  sampling?: Record<string, string>;
  /** The evaluator that judged the run. */
  evaluator: { id: string; version: string; rubricVersion?: string };
  /** Which protocol version's economics priced the run. */
  feeSchedule: string;
  /** Which version of that schedule. */
  feeScheduleVersion: string;
  /** The scaffold version, when the operator knows it. */
  scaffold?: string;
  /** The system prompt's digest, when the operator computed one. */
  systemPromptDigest?: Hex;
  /** The tools the agent was permitted. Sorted before hashing. */
  tools?: string[];
  /** The per-tool permission digests. */
  toolPermissions?: Record<string, Hex>;
}

/**
 * The facts only the run knows.
 *
 * The environment is recorded as it was **resolved**, and the image string
 * is recorded whether or not it names a digest. A tag is a name that can
 * point at different bytes tomorrow; a manifest that recorded only a digest
 * could not say what actually ran.
 */
export interface RunEnvironment {
  /** The sandbox specification the run used. */
  sandbox?: SandboxSpec;
  /** The trial tier, which raises the sandbox floor (gate 901). */
  tier?: TrialTier;
  /** The run's wall-clock budget, in milliseconds. */
  timeoutMs?: number;
  /** True when execution was NOT containerised. */
  degraded: boolean;
}

/**
 * The network policy the sandbox enforced.
 *
 * Read from the sandbox specification rather than assumed, because the
 * egress allowlist is one of the things that makes a run's result mean
 * something: an agent that could reach the internet could fetch the answer.
 */
function networkPolicyOf(sandbox: SandboxSpec | undefined): string | undefined {
  if (!sandbox) return undefined;
  const egress = (sandbox as { egress?: { allow?: string[]; deny?: string[] } }).egress;
  if (!egress) return "unspecified";
  return `allow:${(egress.allow ?? []).length}/deny:${(egress.deny ?? []).length}`;
}

/**
 * The environment the run executed in.
 */
export function environmentOf(run: RunEnvironment): EvalManifest["environment"] {
  const image = run.sandbox?.image ?? resolveVerifierImage();
  const limits: Record<string, string> = {};
  if (run.sandbox?.memory !== undefined) limits.memory = String(run.sandbox.memory);
  if (run.sandbox?.cpus !== undefined) limits.cpus = String(run.sandbox.cpus);
  if (run.sandbox?.timeoutSec !== undefined) limits.wallClockSec = String(run.sandbox.timeoutSec);
  return {
    imageDigest: image as Hex,
    networkPolicy: networkPolicyOf(run.sandbox),
    ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

/**
 * Build the manifest for a run.
 *
 * Every field the operator did not supply is **absent**, not defaulted. A
 * manifest that filled in a missing rubric version with "1" or a missing
 * scaffold with a placeholder would be indistinguishable, to every consumer,
 * from one that knew the value.
 *
 * The decision is the runner's own: it ran the pinned suite, so the
 * deterministic suite decided.
 */
export function buildRunManifest(
  inputs: ManifestInputs,
  run: RunEnvironment,
  startedAt: string,
  finishedAt: string,
): EvalManifest {
  const hasAgentFacts =
    inputs.scaffold !== undefined ||
    inputs.systemPromptDigest !== undefined ||
    inputs.tools !== undefined;
  return buildEvalManifest({
    taskDigest: inputs.specDigest,
    ...(inputs.datasetDigest ? { datasetDigest: inputs.datasetDigest } : {}),
    suiteDigest: inputs.suiteDigest,
    evaluator: inputs.evaluator,
    model: { provider: inputs.provider, name: inputs.model, version: inputs.modelVersion },
    ...(hasAgentFacts
      ? {
          agent: {
            operator: "runner",
            scaffold: inputs.scaffold ?? "unrecorded",
            ...(inputs.systemPromptDigest ? { systemPromptDigest: inputs.systemPromptDigest } : {}),
            ...(inputs.tools ? { tools: [...inputs.tools].sort() } : {}),
            ...(inputs.toolPermissions ? { toolPermissions: inputs.toolPermissions } : {}),
          },
        }
      : {}),
    environment: environmentOf(run),
    seed: inputs.seed,
    ...(inputs.sampling ? { sampling: inputs.sampling } : {}),
    scoring: {
      feeSchedule: inputs.feeSchedule,
      feeScheduleVersion: inputs.feeScheduleVersion,
      decision: "deterministic-suite",
    },
    startedAt,
    finishedAt,
  });
}

/**
 * The manifest and its digest, as a run reports them.
 *
 * The digest is what a consumer fetches by; the manifest is what they read.
 * Both travel, because a digest with no document behind it cannot be
 * checked and a document with no digest cannot be found.
 */
export interface EmittedManifest {
  manifest: EvalManifest;
  digest: Hex;
}

export function emitManifest(
  inputs: ManifestInputs,
  run: RunEnvironment,
  startedAt: string,
  finishedAt: string,
): EmittedManifest {
  const manifest = buildRunManifest(inputs, run, startedAt, finishedAt);
  return { manifest, digest: manifestDigest(manifest) };
}
