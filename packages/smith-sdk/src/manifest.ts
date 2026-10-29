import { keccak256, stringToHex, type Hex } from "viem";
import { canonicalize } from "json-canonicalize";

/**
 * The evaluation manifest - what was evaluated, under exactly which
 * conditions.
 *
 * `RunArtifact` answers "what did the agent produce". This answers "what was
 * asked, of what, by whom, with which judge, in which environment, at which
 * temperature" - and it answers it as a **digest**, so two scores can be
 * compared only when the things that produced them were the same.
 *
 * **Why this is separate from the artifact.** The artifact is signed by the
 * runner and pinned on chain; it must stay exactly what the agent's signer
 * attested to, and every field in it is a fact about the *run*. The manifest
 * is a fact about the *evaluation*, and it is hashed rather than signed:
 * nobody needs to vouch for it, because it is derived from inputs that are
 * themselves content-addressed. Changing the manifest changes the digest;
 * it does not change the signature, the artifact, or anything on chain.
 *
 * **What a digest buys.** Two results may be compared only if their
 * manifests agree on every field. A score that changed because the rubric
 * changed is not a model improvement; a score that changed because the
 * scaffold changed is not a model improvement either. `compareManifests`
 * names the field that moved, so the report can say which.
 *
 * **Every field is a string.** Manifests cross languages and process
 * boundaries, and a numeric field that one implementation renders `0.5` and
 * another renders `0.50` is a digest mismatch with no diagnosis. Numbers are
 * carried as their exact decimal text, and `assertCanonicalNumber` refuses a
 * value that is not the shortest round-trip form.
 */

export const EVAL_MANIFEST_SCHEMA_VERSION = "1.0.0" as const;

/**
 * One evaluator's identity and version.
 *
 * `rubricVersion` is separate from `version` because they move for different
 * reasons and at different rates: the evaluator is code, the rubric is the
 * scoring policy on top of it. A rubric change is a change to what a score
 * *means*, and it is the change most likely to be mistaken for a model change.
 */
export interface EvaluatorPin {
  /** Stable identifier of the evaluator, e.g. `argus`. */
  id: string;
  /** Version of the evaluator implementation. */
  version: string;
  /** Version of the scoring rubric, if the evaluator applies one. */
  rubricVersion?: string;
  /** Digest of the evaluator's own inputs (suite, prompts), if it has any. */
  digest?: Hex;
}

/**
 * The agent side of the evaluation.
 *
 * `scaffold` and `systemPromptDigest` are separated because a scaffold is
 * the harness and a prompt is the instruction; changing either changes the
 * model's behaviour without changing the model.
 */
export interface AgentPin {
  /** Provider or operator that runs the agent. */
  operator: string;
  /** The scaffold/harness identifier and version. */
  scaffold: string;
  /** Digest of the system prompt or instruction set, if it has one. */
  systemPromptDigest?: Hex;
  /** Tool names the agent was permitted, sorted. */
  tools?: string[];
  /** Tool permission digests, sorted by tool name. */
  toolPermissions?: Record<string, Hex>;
}

/**
 * The environment the run executed in.
 *
 * `imageDigest` is the image the sandbox actually ran, not the tag it was
 * requested by: a tag is a name that can point at different bytes, and the
 * whole point of this manifest is that the name cannot be used to hide a
 * change.
 */
export interface EnvironmentPin {
  /** Immutable digest of the runtime image or sandbox root. */
  imageDigest: Hex;
  /** Network policy in force during the run. */
  networkPolicy?: string;
  /** Wall-clock budget the run was given, in milliseconds. */
  timeoutMs?: number;
  /** CPU, memory, process, disk and wall-clock limits. */
  limits?: Record<string, string>;
}

/**
 * The scoring configuration.
 *
 * `feeScheduleVersion` is here because a settlement fee changes what a
 * result is worth, and a leaderboard that mixes two fee schedules is mixing
 * two different games. It is recorded rather than derived: the fee is read
 * off the chain at run time, so the manifest records which schedule the run
 * was priced under.
 */
export interface ScoringPin {
  /** Which protocol version's economics applied: `legacy-v1`, `arena-v2`, ... */
  feeSchedule: string;
  /** Version of the fee schedule itself. */
  feeScheduleVersion: string;
  /** Whether a deterministic suite or a rubric decided the outcome. */
  decision: "deterministic-suite" | "rubric" | "both";
  /** Scoring rules version. */
  rulesVersion?: string;
}

/**
 * The complete manifest.
 *
 * Required fields are the ones without which a score cannot be interpreted:
 * the task, the data, the suite, the evaluator, the model, the seed and the
 * scoring configuration. Everything else is optional because not every
 * evaluation has it - a model-only run has no agent scaffold, and a
 * deterministic suite has no rubric.
 */
export interface EvalManifest {
  schemaVersion: typeof EVAL_MANIFEST_SCHEMA_VERSION;
  /** Digest of the task specification. */
  taskDigest: Hex;
  /** Digest of the dataset version, if the task used one. */
  datasetDigest?: Hex;
  /** Digest of the test suite. */
  suiteDigest: Hex;
  /** The evaluator that judged the run. */
  evaluator: EvaluatorPin;
  /** Model identity: provider, model, and the exact version/snapshot. */
  model: {
    provider: string;
    /** The model name as the provider reports it. */
    name: string;
    /** The exact version or snapshot. A moving alias is not a version. */
    version: string;
  };
  /** The agent side, when the run was an agent rather than a bare model. */
  agent?: AgentPin;
  /** The environment the run executed in. */
  environment: EnvironmentPin;
  /** Seed for every stochastic component. */
  seed: string;
  /** Sampling parameters, as exact decimal text. */
  sampling?: Record<string, string>;
  /** How the outcome was decided and what it was worth. */
  scoring: ScoringPin;
  /** ISO-8601 timestamps: when the run started and finished. */
  startedAt: string;
  finishedAt: string;
}

/**
 * The digest of a manifest: keccak256 over RFC 8785 canonical JSON.
 *
 * The same discipline as `computeRunHash`, for the same reason - every party
 * must land on byte-identical input, and JCS is what guarantees it.
 */
export function manifestDigest(manifest: EvalManifest): Hex {
  return keccak256(stringToHex(canonicalize(manifest)));
}

/**
 * A canonical decimal string, or a refusal.
 *
 * JCS renders numbers with `Number::toString`, so `0.5` and `0.50` are the
 * same number and hash the same - which is correct for JSON, but it means a
 * manifest field written as `0.50` and one written as `0.5` are
 * indistinguishable after the fact. Refusing the non-canonical form at
 * construction time keeps the *input* honest even though the digest could not
 * catch it.
 */
export function assertCanonicalNumber(value: string, field: string): void {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed !== value) {
    throw new Error(`manifest field ${field}: ${JSON.stringify(value)} has surrounding whitespace`);
  }
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
    throw new Error(`manifest field ${field}: ${JSON.stringify(value)} is not a plain decimal`);
  }
  // The shortest round-trip form. "1.50" is a different string from "1.5" and
  // would be rendered as "1.5" by JCS, so the two would hash alike.
  if (Number(trimmed).toString() !== trimmed && trimmed !== "0") {
    throw new Error(
      `manifest field ${field}: ${JSON.stringify(value)} is not the shortest round-trip form`,
    );
  }
}

/**
 * The fields two manifests must agree on for their results to be comparable.
 *
 * `startedAt`/`finishedAt` are excluded deliberately: two runs of the same
 * manifest at different times are still the same evaluation, and a comparison
 * that refused them would refuse every repeat measurement.
 */
export const COMPARABLE_MANIFEST_FIELDS = [
  "taskDigest",
  "datasetDigest",
  "suiteDigest",
  "evaluator",
  "model",
  "agent",
  "environment",
  "seed",
  "sampling",
  "scoring",
] as const;

/**
 * What differs between two manifests, by field path.
 *
 * The paths are dotted and deep, so a caller can say "the rubric moved" or
 * "the temperature moved" without parsing a JSON diff. A field present in one
 * manifest and absent in the other is a difference - `null` vs `undefined` is
 * exactly the case where "the tool set was pinned" and "the tool set was not"
 * would otherwise compare equal.
 */
export interface ManifestDifference {
  /** Dotted path of the field that differs. */
  path: string;
  /** The value in the left manifest, or `undefined` if absent. */
  left: unknown;
  /** The value in the right manifest, or `undefined` if absent. */
  right: unknown;
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    out.set(prefix, value);
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    out.set(prefix, value);
    return;
  }
  for (const key of keys) {
    flatten(record[key], prefix ? `${prefix}.${key}` : key, out);
  }
}

/**
 * Compare two manifests field by field.
 *
 * The result is the *evidence* for a comparison claim. An empty array means
 * the two evaluations are the same evaluation and their scores are
 * comparable; a non-empty array names precisely what moved, which is the
 * difference between "the model improved" and "the rubric moved".
 */
export function compareManifests(left: EvalManifest, right: EvalManifest): ManifestDifference[] {
  const leftFlat = new Map<string, unknown>();
  const rightFlat = new Map<string, unknown>();
  flatten(left, "", leftFlat);
  flatten(right, "", rightFlat);
  const paths = new Set([...leftFlat.keys(), ...rightFlat.keys()]);
  const differences: ManifestDifference[] = [];
  for (const path of [...paths].sort()) {
    const l = leftFlat.get(path);
    const r = rightFlat.get(path);
    const lMissing = !leftFlat.has(path);
    const rMissing = !rightFlat.has(path);
    if (lMissing || rMissing) {
      differences.push({ path, left: lMissing ? undefined : l, right: rMissing ? undefined : r });
      continue;
    }
    if (JSON.stringify(l) !== JSON.stringify(r)) {
      differences.push({ path, left: l, right: r });
    }
  }
  return differences;
}

/**
 * Whether two results may be compared at all.
 *
 * A comparison across two different fee schedules is not a comparison - it
 * mixes two games - and neither is a comparison across two rubrics. The
 * fields that decide this are the ones that change what a score *means*.
 */
export function manifestsComparable(left: EvalManifest, right: EvalManifest): boolean {
  return compareManifests(left, right).every((d) => d.path === "startedAt" || d.path === "finishedAt");
}

/**
 * Build a manifest, refusing the inputs that would make it unhonest.
 *
 * The checks are the ones a later reader cannot check: a moving model alias,
 * an unpinned evaluator, a non-canonical number. Everything else is a fact
 * about the world that the manifest records.
 */
export function buildEvalManifest(args: {
  taskDigest: Hex;
  datasetDigest?: Hex;
  suiteDigest: Hex;
  evaluator: EvaluatorPin;
  model: { provider: string; name: string; version: string };
  agent?: AgentPin;
  environment: EnvironmentPin;
  seed: string;
  sampling?: Record<string, string>;
  scoring: ScoringPin;
  startedAt: string;
  finishedAt: string;
}): EvalManifest {
  const { evaluator, model, sampling } = args;
  if (evaluator.id.trim() === "" || evaluator.version.trim() === "") {
    throw new Error("manifest evaluator needs an id and a version");
  }
  if (model.provider.trim() === "" || model.name.trim() === "" || model.version.trim() === "") {
    throw new Error("manifest model needs a provider, a name and an exact version");
  }
  // A moving alias is not a version. This is the same rule the model card
  // enforces for the grader (gate 504), applied here so an evaluation cannot
  // be published against "gpt-latest" and still be comparable later.
  if (/(^|[:\-])(latest|live|default|preview|stable)$/i.test(model.version.trim())) {
    throw new Error(
      `manifest model version "${model.version}" is a moving alias. Pin an exact version or snapshot.`,
    );
  }
  if (args.seed.trim() === "") {
    throw new Error("manifest needs a seed for every stochastic component");
  }
  if (!Number.isFinite(Date.parse(args.startedAt)) || !Number.isFinite(Date.parse(args.finishedAt))) {
    throw new Error("manifest timestamps must be ISO-8601 dates");
  }
  if (sampling) {
    for (const [key, value] of Object.entries(sampling)) {
      assertCanonicalNumber(value, `sampling.${key}`);
    }
  }
  if (args.agent?.tools && args.agent.tools.length > 0) {
    const sorted = [...args.agent.tools].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(args.agent.tools)) {
      throw new Error("manifest agent.tools must be sorted so two equal sets hash alike");
    }
  }
  return {
    schemaVersion: EVAL_MANIFEST_SCHEMA_VERSION,
    taskDigest: args.taskDigest,
    ...(args.datasetDigest ? { datasetDigest: args.datasetDigest } : {}),
    suiteDigest: args.suiteDigest,
    evaluator,
    model,
    ...(args.agent ? { agent: args.agent } : {}),
    environment: args.environment,
    seed: args.seed,
    ...(sampling ? { sampling } : {}),
    scoring: args.scoring,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
  };
}
