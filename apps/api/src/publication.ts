/**
 * @file publication.ts — what a published score was measured against, and
 * what it does not establish.
 *
 * A score on its own is a number with no method attached to it. Two scores
 * can both look like "0.82" and have been measured against different suites,
 * different rubrics and different judges, which makes them incomparable —
 * and a comparison that does not say so is a claim nobody checked.
 *
 * So a publication is the METHOD CARD of a score:
 *
 *   - the suite version it was measured against, by digest;
 *   - the rubric, dimension by dimension, with the weight each dimension
 *     carries and the methodology behind it;
 *   - the judge configuration;
 *   - the repetitions that were run, and whether they agreed;
 *   - the LIMITS — what this score does NOT establish, derived from the
 *     data and not written by hand;
 *   - a content address over all of it, so a published method cannot change
 *     afterwards. A change publishes a NEW card.
 *
 * The limits are the point. A number without its limits is a marketing
 * claim; a number with them is a measurement, and a reader can decide
 * whether it answers their question.
 *
 * Two publications are COMPARABLE when they were measured against the same
 * suite digest and the same rubric. When they are not, the comparison says
 * so and says why — an explicit "not comparable" verdict, rather than a
 * subtraction that would be meaningless.
 */

import { hashCanonical } from "@crucible/crypto";
import {
  getAggregateScore,
  getDimensionScores,
  getRubric,
  type AggregateScore,
  type DimensionScore,
  type Rubric,
} from "./scoring.js";
import {
  getLatestSuiteVersion,
  getSuite,
  getSuiteVersion,
  listSuites,
  type Suite,
  type SuiteVersion,
} from "./suites.js";
import {
  listManifestsByRun,
  listManifestsByTrial,
  listReplaysByManifest,
  type ReplayManifest,
  type ReplayRecord,
} from "./replay-manifest.js";
import { computeMeasurementKey, listSpecsByTrial, type EvaluationSpec } from "./evaluation-spec.js";
import { REQUIRED_REPLAYS } from "./replay-policy.js";

/* ------------------------------------------------------------------ */
/* The card                                                           */
/* ------------------------------------------------------------------ */

/** What is being described. */
export interface PublicationSubject {
  kind: "run" | "trial";
  id: string;
  agentId: string;
  agentVersion?: string;
}

export interface PublishedSuite {
  suiteId: string;
  name: string;
  versionId: string;
  version: string;
  /** The digest the chain and the spec agree on. */
  specDigest: string;
  difficulty: string;
  evaluationProtocol: string;
  /** The suite author's own statement of what it does not cover. */
  knownLimitations: string;
}

export interface PublishedDimension {
  dimension: string;
  /** The weight in basis points (1/10000), so no float crosses the wire. */
  weightBps: number;
  /** The methodology the rubric publishes for this dimension. */
  methodology: string;
  /** The score for this dimension, in basis points, when there is one. */
  scoreBps: number | null;
}

export interface PublishedRubric {
  rubricId: string;
  name: string;
  status: string;
  dimensions: PublishedDimension[];
  /** The aggregate in basis points. */
  aggregateBps: number | null;
  confidenceLowerBps: number | null;
  confidenceUpperBps: number | null;
  sampleCount: number;
  scoreStatus: string | null;
}

export interface PublishedJudge {
  /** The judge version string the manifest carries. */
  judgeVersion: string | null;
  /** The runtime that judged, by image digest. */
  runtimeImageDigest: string | null;
  /** The environment fingerprint the run measured. */
  environmentFingerprint: string | null;
  /** The judge configuration as published, by digest — its contents are the operator's. */
  configDigest: string | null;
  modelId: string | null;
}

export interface PublishedRepetitions {
  required: number;
  performed: number;
  /** Did the repetitions agree? */
  agreed: boolean | null;
  /** The rule, in words: what agreement means. */
  agreementRule: string;
  /** One line per replay: which worker, what it produced, how it ended. */
  replays: {
    replayNumber: number;
    workerIdentity: string;
    outputDigest: string | null;
    status: string;
  }[];
}

export interface PublishedMethod {
  id: string;
  subject: PublicationSubject;
  /** The pinned spec's digest — the content address of the MEASUREMENT. */
  specDigest: string | null;
  /**
   * What was MEASURED, with the agent left out.
   *
   * Two scores may be compared when this key matches: the same suite
   * version, the same rubric and the same judge. The subject is not part
   * of it — comparing two agents' scores is the whole point.
   */
  measurementKey: string;
  /** Where the measurement key came from: the pinned spec, or the manifest. */
  measurementKeySource: "spec" | "manifest";
  suite: PublishedSuite | null;
  rubric: PublishedRubric;
  judge: PublishedJudge;
  repetitions: PublishedRepetitions;
  /** What this score does NOT establish. */
  limits: string[];
  /** The key two publications must share to be comparable. */
  comparabilityKey: string;
  /** The content address over everything above. */
  digest: string;
  publishedAt: number;
}

/* ------------------------------------------------------------------ */
/* Reading the inputs                                                 */
/* ------------------------------------------------------------------ */

/** A weight in basis points. A float never crosses this line. */
function toBps(value: number): number {
  return Math.round(value * 10000);
}

/** A score in basis points. */
function scoreToBps(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 10000);
}

function publishedSuite(
  suiteId: string | undefined,
  versionId: string | undefined,
): PublishedSuite | null {
  if (!suiteId) return null;
  const suite: Suite | undefined = getSuite(suiteId);
  const version: SuiteVersion | undefined = versionId
    ? getSuiteVersion(versionId)
    : getLatestSuiteVersion(suiteId);
  if (!suite && !version) return null;
  return {
    suiteId,
    name: suite?.name ?? "",
    versionId: version?.id ?? "",
    version: version?.version ?? "",
    // The digest is the identity. Without it the card names a suite but not
    // the thing that was measured.
    //
    // NOTE: this is the SUTE VERSION's digest, never the evaluation spec's
    // digest. The spec digest covers the whole evaluation (judge, policy,
    // environment); the suite digest covers the thing being measured. Two
    // scores may share a spec digest and still be measured against different
    // suites, and one spec digest is not a substitute for the other. When
    // the version cannot be resolved the field stays empty and the limits
    // say so, rather than substituting a digest of a different meaning.
    specDigest: version?.specDigest ?? "",
    difficulty: version?.difficulty ?? "unknown",
    evaluationProtocol: version?.evaluationProtocol ?? "unknown",
    knownLimitations: version?.knownLimitations ?? "",
  };
}

/* ------------------------------------------------------------------ */
/* The limits                                                         */
/* ------------------------------------------------------------------ */

/**
 * The limits of a published score, DERIVED from the data.
 *
 * Every line is a statement about what the score does not establish. None of
 * them is decoration: each one is the consequence of something the reader
 * would otherwise have to know to interpret the number.
 */
export function deriveLimits(input: {
  suite: PublishedSuite | null;
  rubric: PublishedRubric;
  judge: PublishedJudge;
  repetitions: PublishedRepetitions;
  scoreStatus: string | null;
  /** Whether the measurement was pinned by a spec, or only by the manifest. */
  measurementKeySource?: "spec" | "manifest";
}): string[] {
  const limits: string[] = [];

  // Always. A score measured one way says nothing about the subject beyond
  // that measurement — and the sentence names WHAT was measured, because a
  // limit that points at a suite the card does not carry is noise.
  limits.push(
    input.suite
      ? "This score establishes only what was measured against the suite version above. It does not establish general capability, and it does not transfer to another suite."
      : "This score establishes only what the pinned measurement above covered. It does not establish general capability, and it does not transfer to another measurement.",
  );

  if (input.measurementKeySource === "manifest") {
    limits.push(
      "This measurement was pinned by its manifest alone, not by an evaluation spec, so it cannot be compared with a spec-pinned measurement.",
    );
  }

  if (!input.suite) {
    limits.push(
      "The suite this score was measured against is not published, so the measurement cannot be reproduced from this card.",
    );
  } else if (!input.suite.specDigest) {
    limits.push(
      "No suite digest is published for this measurement, so it cannot be confirmed that two scores were measured against the same suite.",
    );
  }

  if (input.suite?.knownLimitations) {
    limits.push(`The suite's own published limitations apply: ${input.suite.knownLimitations}`);
  }

  for (const dimension of input.rubric.dimensions) {
    if (!dimension.methodology) {
      limits.push(
        `The ${dimension.dimension} dimension carries no published methodology, so ${Math.round(
          dimension.weightBps / 100,
        )}% of this score is unexplained.`,
      );
    }
  }

  if (input.scoreStatus === "PROVISIONAL") {
    limits.push("This score is provisional: it has not been verified against the chain.");
  }
  if (input.scoreStatus === "DISPUTED") {
    limits.push("This score is disputed: a break has been filed against it.");
  }
  if (input.scoreStatus === "REVOKED") {
    limits.push("This score has been revoked and must not be used.");
  }
  if (input.rubric.confidenceLowerBps === null || input.rubric.confidenceUpperBps === null) {
    limits.push("No confidence interval is published for this score, so the spread around it is unknown.");
  }

  if (input.repetitions.performed < input.repetitions.required) {
    limits.push(
      `The agreement rule was not met: ${input.repetitions.performed} of ${input.repetitions.required} required repetitions were run.`,
    );
  }
  if (input.repetitions.agreed === false) {
    limits.push(
      "The repetitions did not agree, so this result does not follow from the task and is not publishable as a score.",
    );
  }

  if (!input.judge.judgeVersion) {
    limits.push("No judge version is published, so the grading cannot be reproduced.");
  }
  if (!input.judge.runtimeImageDigest) {
    limits.push("No runtime image digest is published, so the environment that graded cannot be identified.");
  }

  return limits;
}

/* ------------------------------------------------------------------ */
/* Comparability                                                      */
/* ------------------------------------------------------------------ */

/**
 * Whether two publications may be compared, and why not when they may not.
 *
 * The comparison is refused when the suite digest differs, when the rubric
 * differs, or when either score is not publishable. It is NOT refused
 * because the numbers are close or far.
 */
export function comparePublications(
  a: PublishedMethod,
  b: PublishedMethod,
): { comparable: boolean; reason: string; differences: string[] } {
  const differences: string[] = [];

  if (a.measurementKey !== b.measurementKey) {
    differences.push(
      `different measurements (${a.measurementKeySource} keys ${a.measurementKey} and ${b.measurementKey})`,
    );
  }
  if (a.rubric.rubricId !== b.rubric.rubricId) {
    differences.push(`different rubrics (${a.rubric.rubricId} and ${b.rubric.rubricId})`);
  }
  if (a.judge.judgeVersion !== b.judge.judgeVersion) {
    differences.push(`different judge versions (${a.judge.judgeVersion} and ${b.judge.judgeVersion})`);
  }
  for (const side of [a, b]) {
    if (side.rubric.scoreStatus === "REVOKED") {
      differences.push("one of the scores has been revoked");
    }
    if (side.repetitions.agreed === false) {
      differences.push("one of the scores rests on repetitions that did not agree");
    }
  }

  if (differences.length > 0) {
    return {
      comparable: false,
      reason: `These two scores were not measured the same way: ${differences.join("; ")}. Comparing them would compare two different things.`,
      differences,
    };
  }
  return {
    comparable: true,
    reason:
      "Both scores were measured the same way: the same measurement, the same rubric and the same judge version.",
    differences: [],
  };
}

/* ------------------------------------------------------------------ */
/* Assembling a card                                                  */
/* ------------------------------------------------------------------ */

/** Everything the assembler needs. */
export interface PublicationInput {
  manifest: ReplayManifest;
  /** The pinned spec of the measurement, when there is one. */
  spec?: EvaluationSpec;
  /** The replays of this manifest, if they have been recorded. */
  replays: ReplayRecord[];
  /** The aggregate score for the run, when one exists. */
  aggregate: AggregateScore | undefined;
  /** The dimension scores for the run, when they exist. */
  dimensionScores: DimensionScore[];
  /** The rubric the score used. */
  rubric: Rubric | undefined;
  /** The suite and version, when they can be resolved. */
  suiteVersion: SuiteVersion | undefined;
  suite: Suite | undefined;
  publishedAt: number;
}

/**
 * Assemble the method card.
 *
 * The card is content-addressed: the digest is over everything EXCEPT the
 * id, the digest itself and the publication time, so publishing the same
 * method twice yields the same address — and a card can never be edited
 * afterwards, because any change produces a different address.
 */
export function assemblePublication(input: PublicationInput): PublishedMethod {
  const { manifest, replays, aggregate, dimensionScores, rubric, suiteVersion, suite, spec } = input;

  const outputDigests = replays.map((r) => r.outputHash).filter((h): h is string => typeof h === "string");
  const agreed =
    replays.length === 0
      ? null
      : outputDigests.length === replays.length && new Set(outputDigests).size === 1;

  // The rubric of a measurement is pinned in the SPEC, not only in the
  // rubric store: a card published before a score exists still has to say
  // what it WILL be scored against, and a card published from the rubric
  // store alone would lose the pinned weights.
  const pinnedDimensions = spec?.scoringMethodology.dimensions ?? [];
  const dimensionNames = rubric
    ? rubric.dimensions.map((d) => d.dimension)
    : pinnedDimensions.map((d) => d.name);

  const rubricDimensions = dimensionNames.map((name) => {
    const config = rubric?.dimensions.find((d) => d.dimension === name);
    const pinned = pinnedDimensions.find((d) => d.name === name);
    const scored = dimensionScores.find((s) => s.dimension === name);
    return {
      dimension: name,
      weightBps: toBps(config?.weight ?? pinned?.weight ?? 0),
      methodology: config?.methodology ?? "",
      scoreBps: scoreToBps(scored?.score),
    };
  });

  const publishedRubric: PublishedRubric = {
    rubricId: rubric?.id ?? aggregate?.rubricId ?? "",
    name: rubric?.name ?? "",
    status: rubric?.status ?? "unknown",
    dimensions: rubricDimensions,
    aggregateBps: scoreToBps(aggregate?.score),
    confidenceLowerBps: scoreToBps(aggregate?.confidenceLower),
    confidenceUpperBps: scoreToBps(aggregate?.confidenceUpper),
    sampleCount: aggregate?.sampleCount ?? 0,
    scoreStatus: aggregate?.status ?? null,
  };

  const suiteCard = publishedSuite(suite?.id, suiteVersion?.id);

  const publishedJudge: PublishedJudge = {
    judgeVersion: manifest.judgeVersion || null,
    runtimeImageDigest: manifest.runtimeImageDigest || null,
    environmentFingerprint: manifest.environmentFingerprint || null,
    configDigest: manifest.executionConfig && Object.keys(manifest.executionConfig).length > 0
      ? hashCanonical(manifest.executionConfig)
      : null,
    modelId: manifest.modelId ?? null,
  };

  const publishedRepetitions: PublishedRepetitions = {
    required: REQUIRED_REPLAYS,
    performed: replays.length,
    agreed,
    agreementRule:
      "Three independent replays of the same pinned task must produce the same result; " +
      "the score is publishable only when they agree.",
    replays: [...replays]
      .sort((a, b) => a.replayNumber - b.replayNumber)
      .map((replay) => ({
        replayNumber: replay.replayNumber,
        workerIdentity: replay.workerIdentity,
        outputDigest: replay.outputHash ?? null,
        status: replay.status,
      })),
  };

  const limits = deriveLimits({
    suite: suiteCard,
    rubric: publishedRubric,
    judge: publishedJudge,
    repetitions: publishedRepetitions,
    scoreStatus: publishedRubric.scoreStatus,
    measurementKeySource: spec ? "spec" : "manifest",
  });

  const subject: PublicationSubject = {
    kind: "trial",
    id: manifest.trialId,
    agentId: manifest.agentId,
    agentVersion: manifest.agentVersion,
  };

  // The comparability key: what must be the same for two numbers to mean
  // the same thing.
  //
  // It is the MEASUREMENT key (the thing measured, with the subject left
  // out), the rubric and the judge. It is NOT the suite digest alone: a
  // measurement made against a workload profile has no suite, and two
  // scores of the same pinned task are comparable exactly as two scores of
  // the same suite version are.
  const measurementKey = spec ? computeMeasurementKey(spec) : manifest.specDigest;
  const measurementKeySource: "spec" | "manifest" = spec ? "spec" : "manifest";
  const comparabilityKey = [
    measurementKey || "no-measurement",
    publishedRubric.rubricId || "no-rubric",
    publishedJudge.judgeVersion || "no-judge",
  ].join("/");

  const body = {
    subject,
    specDigest: manifest.specDigest || null,
    measurementKey,
    measurementKeySource,
    suite: suiteCard,
    rubric: publishedRubric,
    judge: publishedJudge,
    repetitions: publishedRepetitions,
    limits,
    comparabilityKey,
  };

  const digest = hashCanonical(body);
  const id = `pub_${digest.slice(0, 32)}`;

  return { id, ...body, digest, publishedAt: input.publishedAt };
}

/* ------------------------------------------------------------------ */
/* Finding the inputs                                                 */
/* ------------------------------------------------------------------ */

/**
 * Publish the method of a trial: find the manifest, the replays, the score
 * and the rubric, and assemble the card.
 *
 * Returns null when there is nothing to publish — a trial with no replay
 * manifest has no method to publish, and a card with blanks in it would be
 * a card that says nothing.
 */
export function publishForTrial(trialId: string, publishedAt: number): PublishedMethod | null {
  const manifests = listManifestsByTrial(trialId);
  const manifest = manifests[manifests.length - 1];
  if (!manifest) return null;
  return publishForManifest(manifest, publishedAt);
}

/** Publish the method of one run. */
export function publishForRun(runId: string, publishedAt: number): PublishedMethod | null {
  const manifests = listManifestsByRun(runId);
  const manifest = manifests[manifests.length - 1];
  if (!manifest) return null;
  return publishForManifest(manifest, publishedAt);
}

/** Publish the method of one manifest. */
export function publishForManifest(manifest: ReplayManifest, publishedAt: number): PublishedMethod | null {
  const aggregate = getAggregateScore(manifest.runId);
  const dimensionScores = getDimensionScores(manifest.runId);
  const rubric = aggregate ? getRubric(aggregate.rubricId) : undefined;
  const spec = findSpec(manifest);
  const suiteVersion = findSuiteVersion(manifest);
  const suite = suiteVersion ? getSuite(suiteVersion.suiteId) : undefined;
  return assemblePublication({
    manifest,
    spec,
    replays: replaysOf(manifest),
    aggregate,
    dimensionScores,
    rubric,
    suiteVersion,
    suite,
    publishedAt,
  });
}

/** The replays recorded against a manifest. */
function replaysOf(manifest: ReplayManifest): ReplayRecord[] {
  return listReplaysByManifest(manifest.manifestId);
}

/**
 * The suite version a manifest was measured against, when it can be found.
 *
 * The PINNED SPEC is the authority: it carries both the suite id and the
 * version id, and its digest is the digest the manifest carries. The
 * manifest's own `suiteVersion` string is a label, which is not enough on
 * its own — two versions of a suite share a label across suites — so it is
 * the fallback, not the first answer.
 */
function findSuiteVersion(manifest: ReplayManifest): SuiteVersion | undefined {
  const spec = findSpec(manifest);
  if (spec) {
    const version = getSuiteVersion(spec.suiteVersionId);
    if (version) return version;
  }
  const byId = getSuiteVersion(manifest.suiteVersion);
  if (byId) return byId;
  // The manifest carries the version label; find the suite that has it.
  for (const suite of listAllSuites()) {
    const version = getLatestSuiteVersion(suite.id);
    if (version && version.version === manifest.suiteVersion) return version;
  }
  return undefined;
}

/** The pinned spec of the run this manifest belongs to, when there is one. */
function findSpec(manifest: ReplayManifest): EvaluationSpec | undefined {
  const specs = listSpecsByTrial(manifest.trialId);
  // The newest spec for the trial; the manifest was created against it.
  const newest = specs[specs.length - 1];
  if (newest && newest.specDigest === manifest.specDigest) return newest;
  return newest;
}

function listAllSuites(): Suite[] {
  return listSuites({});
}
