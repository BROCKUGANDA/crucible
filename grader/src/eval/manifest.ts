import {
  buildEvalManifest,
  manifestDigest,
  type EvalManifest,
} from "@crucible/smith";
import type { Hex } from "viem";
import type { ModelCard } from "./frontier.js";
import type { SuiteEpoch, SuiteName } from "./types.js";

/**
 * The evaluation manifest for a graded row.
 *
 * A scorecard row says how a model did. It did not say **what was asked, of
 * what, by whom, at which temperature** - and that is the half that makes a
 * score attributable. Two rows reading `suite: "smoke"` are two different
 * exams if the corpus changed, and the row's own `suiteEpoch` proves it. But
 * the epoch names the *corpus*; it says nothing about the seed, the prompt
 * version, the evaluator or the thresholds, and those change the score too.
 *
 * So the grader builds a manifest for every row and attaches its digest to
 * the row. A published score then points at the exact inputs that produced
 * it, and two rows can be compared only when their manifests agree.
 *
 * **The manifest is the grader's own evaluation, not a runner's.** A grader
 * run evaluates a *model* against a corpus; it does not execute an agent in a
 * sandbox. So there is no scaffold, no tool set and no environment image -
 * and the manifest says so by omission rather than by filling them in.
 *
 * **What it records:** the corpus digest (the exam), the evaluator, the
 * model's exact snapshot, the seed and the draw hash (the reproducibility
 * inputs), the prompt version (the harness), and the scoring rules
 * (thresholds). It does not record a fee, because the grader does not
 * settle anything - it prices nothing.
 */

/** The inputs the grader knows about one row's evaluation. */
export interface GraderManifestInputs {
  /** The model that was graded. */
  modelId: string;
  /** The provider that served it. */
  provider: string;
  /** The model card, which pins the exact snapshot. */
  card: ModelCard;
  /** The suite that was run. */
  suite: SuiteName;
  /** The digest of the corpus the row was scored against. */
  suiteEpoch: SuiteEpoch;
  /** The digest of the whole exam set, so a row names its place in it. */
  corpusEpoch: SuiteEpoch;
  /** The prompt version - the harness's own version. */
  promptVersion: string;
  /** The seed the draw was taken with. */
  seed: string;
  /** The commitment to the seed, so the draw can be audited. */
  seedCommitment?: string;
  /** The hash of the draw itself. */
  drawHash?: string;
  /** The evaluator's own version. */
  evaluatorVersion: string;
  /** The rubric version, when the suite applies one. */
  rubricVersion?: string;
  /** The scoring thresholds in force, as exact decimal text. */
  thresholds: Record<string, string>;
  /** The ISO-8601 start and finish of the evaluation. */
  startedAt: string;
  finishedAt: string;
}

/**
 * The manifest for a graded row.
 *
 * The corpus digest appears as both `taskDigest` and `suiteDigest`: in the
 * grader the exam and the corpus are the same bytes, and recording them
 * twice under two names that mean different things elsewhere would be a
 * claim the grader cannot support. A runner's manifest - where the task and
 * the suite really are different artifacts - is unaffected.
 */
export function graderManifest(inputs: GraderManifestInputs): EvalManifest {
  return buildEvalManifest({
    taskDigest: inputs.suiteEpoch as Hex,
    suiteDigest: inputs.suiteEpoch as Hex,
    evaluator: {
      id: "grader",
      version: inputs.evaluatorVersion,
      // The prompt version is the harness's own version - which harness ran
      // the model - so it is recorded beside the evaluator rather than in the
      // sampling block, where a version string would be read as a number.
      rubricVersion: inputs.rubricVersion ?? inputs.promptVersion,
    },
    model: {
      provider: inputs.provider,
      name: inputs.modelId,
      // The snapshot is the exact version. A card whose snapshot is a moving
      // alias is refused by the card validator before it gets here.
      version: inputs.card.snapshot,
    },
    environment: {
      // The grader's environment is the corpus it holds in memory. There is
      // no sandbox image, and inventing one would be a lie about a
      // measurement.
      imageDigest: inputs.corpusEpoch as Hex,
      networkPolicy: "none",
    },
    seed: inputs.seed,
    // The sampling block carries numbers only - it is the place a consumer
    // looks for "temperature", and a string in there would be read as a
    // number. The prompt version is a *harness* fact, so it goes in the
    // evaluator pin, where a version string belongs.
    sampling: inputs.thresholds,
    scoring: {
      feeSchedule: "none",
      feeScheduleVersion: "0",
      decision: "deterministic-suite",
      rulesVersion: inputs.rubricVersion ?? inputs.evaluatorVersion,
    },
    startedAt: inputs.startedAt,
    finishedAt: inputs.finishedAt,
  });
}

/** The manifest and its digest, as a row carries them. */
export interface GraderManifest {
  manifest: EvalManifest;
  digest: Hex;
}

export function buildGraderManifest(inputs: GraderManifestInputs): GraderManifest {
  const manifest = graderManifest(inputs);
  return { manifest, digest: manifestDigest(manifest) };
}

/**
 * What the arena knows about one row's evaluation, handed to a manifest
 * builder.
 *
 * The arena knows the model, the suite and the corpus digest. It does **not**
 * know the provider, the model card, the seed or the thresholds - the caller
 * does. So the builder is a caller-supplied function that closes over those
 * facts, and the arena asks it for each row.
 */
export interface ManifestContext {
  modelId: string;
  suite: SuiteName;
  suiteEpoch: SuiteEpoch;
}

/** Builds the manifest for one row. */
export type ManifestBuilder = (ctx: ManifestContext) => GraderManifest;

/**
 * The default builder, for a caller that holds no card, no seed and no
 * provider.
 *
 * It is deliberately **degraded rather than absent**: a row without a
 * manifest has no conditions at all, and a row with a manifest that names its
 * corpus and says "the seed was not recorded" is strictly more useful and
 * strictly more honest than either.
 *
 * **Its one honest limit:** `seed: "unset"` means two rows graded over the
 * same corpus without a recorded draw are indistinguishable by seed. A
 * caller that took a draw supplies the real seed through its own builder, and
 * that is the case that matters for reproducibility.
 */
export function defaultGraderManifest(ctx: ManifestContext): GraderManifest {
  const manifest = buildEvalManifest({
    taskDigest: ctx.suiteEpoch as Hex,
    suiteDigest: ctx.suiteEpoch as Hex,
    evaluator: { id: "grader", version: "0.1.0" },
    model: {
      provider: "unknown",
      // The adapter id names the model under test. It is **not** a version, and
      // it is not used as one: an adapter id is a local name that says which
      // implementation answered, and it says nothing about which release of
      // the model was called. Claiming it as a version would make a row look
      // pinned when nothing was pinned - and the manifest's own rule refuses a
      // moving alias, which several adapter ids trip by ending in "stable".
      name: ctx.modelId,
      version: "unpinned",
    },
    environment: {
      // The grader's environment is the corpus it holds in memory. There is
      // no sandbox image, and inventing one would be a lie about a
      // measurement.
      imageDigest: ctx.suiteEpoch as Hex,
      networkPolicy: "none",
    },
    seed: "unset",
    scoring: {
      feeSchedule: "none",
      feeScheduleVersion: "0",
      decision: "deterministic-suite",
    },
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
  });
  return { manifest, digest: manifestDigest(manifest) };
}
