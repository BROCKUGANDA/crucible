/**
 * @file evidence-bundle.ts — the frozen evidence of a dispute.
 *
 * When a break is filed, two things have to be true for the committees to
 * be able to do their job: the evidence they read must not change under
 * them, and everyone must be reading the SAME evidence.
 *
 * A bundle is that freeze. It is:
 *
 *   - **content-addressed.** The address is the digest of the bundle's own
 *     contents, so a bundle can never be edited afterwards — a change
 *     produces a different address, and the old one keeps pointing at what
 *     it said.
 *   - **complete about its own incompleteness.** The `gaps` array says what
 *     is NOT in the bundle and why. A bundle that silently omitted the
 *     replay manifest would read as a bundle in which the run did not
 *     happen.
 *   - **dated.** `sealedAt` says when the freeze happened, which is what
 *     makes the question "did the parties see this bundle before they
 *     broke the trial?" answerable: a bundle sealed AFTER the break is not
 *     the bundle they saw, and the API says so rather than serving it as
 *     if it were.
 *
 * The bundle carries two things the reader cannot reconstruct alone:
 * what the CHAIN says (the digests committed to, the disclosure CIDs, the
 * break itself) and what the PLATFORM measured (the pinned spec, the
 * replays and whether they agreed, the scores). Both are read, never
 * recomputed — the chain's arithmetic is the chain's.
 */

import { hashCanonical } from "@crucible/crypto";
import { getAggregateScore, getDimensionScores, type AggregateScore, type DimensionScore } from "./scoring.js";
import {
  listManifestsByTrial,
  listReplaysByManifest,
  type ReplayManifest,
  type ReplayRecord,
} from "./replay-manifest.js";
import { listSpecsByTrial, type EvaluationSpec } from "./evaluation-spec.js";
import { computeMeasurementKey } from "./evaluation-spec.js";

/**
 * The chain facts a bundle carries.
 *
 * Every field is nullable, and null means "the chain has not said". A
 * bundle that invented a value here would be the worst artefact in the
 * product: it would be read by people deciding whether money moves.
 */
export interface BundleChainFacts {
  /** The chain's trial id, when the trial is known to the chain. */
  trialId: number | null;
  sponsor: string | null;
  status: string | null;
  verdict: string | null;
  /** The digest the chain committed to for the spec and the tests. */
  specDigest: string | null;
  testsDigest: string | null;
  /** The CIDs the sponsor disclosed for those digests, when disclosed. */
  disclosedSpecCid: string | null;
  disclosedTestsCid: string | null;
  /** Who broke the trial, and the proof they filed. */
  breakSkeptic: string | null;
  breakProofCid: string | null;
  /** When the break was filed (chain seconds). */
  disputeOpenedAt: number | null;
}

/** What the platform measured, as the bundle froze it. */
export interface BundleMeasurement {
  pinnedSpecDigest: string | null;
  /** What was measured, with the subject left out — the comparability key. */
  measurementKey: string | null;
  manifestIds: string[];
  replays: {
    manifestId: string;
    replayNumber: number;
    workerIdentity: string;
    outputDigest: string | null;
    status: string;
  }[];
  /** Did the replays agree? Null when there were none to compare. */
  replaysAgreed: boolean | null;
  dimensions: { dimension: string; weightBps: number; scoreBps: number | null }[];
  aggregateBps: number | null;
  confidenceLowerBps: number | null;
  confidenceUpperBps: number | null;
  sampleCount: number;
  scoreStatus: string | null;
  /** The published method card's address, when the measurement was published. */
  publicationId: string | null;
}

/** A frozen bundle. */
export interface EvidenceBundle {
  id: string;
  /** The subject: the chain's trial id as a string, or the trial key. */
  trialKey: string;
  /** When the freeze happened, on THIS HOST's clock, in milliseconds. */
  sealedAt: number;
  /**
   * When the freeze happened, on the CHAIN's clock, in seconds.
   *
   * Null when this host cannot read the chain's clock — and then the
   * bundle says so rather than pretending the two clocks are the same
   * clock. They are not: the indexer's own note says a client anchors on
   * `max(headTimestamp + 1, now)`, because the chain's clock and the host's
   * clock are two clocks. Comparing a seal time against a dispute time
   * across the two is how a bundle that was sealed FIRST would come to be
   * reported as sealed LAST.
   */
  sealedAtChainSeconds: number | null;
  chain: BundleChainFacts | null;
  measurement: BundleMeasurement;
  /** What is NOT in this bundle, and why. */
  gaps: string[];
  /** The content address over everything above. */
  digest: string;
}

/* ------------------------------------------------------------------ */
/* Assembling                                                        */
/* ------------------------------------------------------------------ */

/** What the assembler needs from the world. */
export interface BundleInput {
  trialKey: string;
  sealedAt: number;
  /**
   * The chain's clock at the seal, in seconds, when the host can read it.
   */
  sealedAtChainSeconds?: number | null;
  /** The chain's facts, when the trial is known to the chain. */
  chain?: Partial<BundleChainFacts> | null;
  /** The pinned spec of the measurement, when there is one. */
  spec?: EvaluationSpec | null;
  /** The manifests of the trial, with their replay records. */
  manifests?: { manifest: ReplayManifest; replays: ReplayRecord[] }[];
  /** The aggregate score of the run, when one exists. */
  aggregate?: AggregateScore | null;
  /** The dimension scores of the run, when they exist. */
  dimensionScores?: DimensionScore[];
  /** The published method card, when the measurement was published. */
  publicationId?: string | null;
}

/** A score in basis points. */
function toBps(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 10000);
}

/**
 * Assemble the bundle, and say what it does not contain.
 *
 * The gaps are the point: a reader who knows what is missing can weigh the
 * evidence, and a reader who does not will assume completeness.
 */
export function assembleBundle(input: BundleInput): EvidenceBundle {
  const gaps: string[] = [];

  const chainFacts = input.chain
    ? {
        trialId: input.chain.trialId ?? null,
        sponsor: input.chain.sponsor ?? null,
        status: input.chain.status ?? null,
        verdict: input.chain.verdict ?? null,
        specDigest: input.chain.specDigest ?? null,
        testsDigest: input.chain.testsDigest ?? null,
        disclosedSpecCid: input.chain.disclosedSpecCid ?? null,
        disclosedTestsCid: input.chain.disclosedTestsCid ?? null,
        breakSkeptic: input.chain.breakSkeptic ?? null,
        breakProofCid: input.chain.breakProofCid ?? null,
        disputeOpenedAt: input.chain.disputeOpenedAt ?? null,
      }
    : null;

  if (!chainFacts) {
    gaps.push(
      "The chain's facts for this trial are not in this bundle: the trial is not known to the chain reader, so nothing here is a chain reading.",
    );
  } else {
    if (!chainFacts.specDigest) {
      gaps.push("The chain committed to no spec digest for this trial.");
    }
    if (!chainFacts.disclosedSpecCid) {
      gaps.push(
        "The sponsor has not disclosed the suite for this trial, so the pinned files behind the committed digest are not in this bundle.",
      );
    }
    if (!chainFacts.breakSkeptic) {
      gaps.push("No break has been filed against this trial, so there is no dispute to answer.");
    } else if (!chainFacts.breakProofCid) {
      gaps.push(
        "A break was filed but its proof was not disclosed, so the break's own evidence is missing from this bundle.",
      );
    }
  }

  const manifests = input.manifests ?? [];
  const replays = manifests.flatMap(({ manifest, replays: records }) =>
    records.map((record) => ({
      manifestId: manifest.manifestId,
      replayNumber: record.replayNumber,
      workerIdentity: record.workerIdentity,
      outputDigest: record.outputHash ?? null,
      status: record.status,
    })),
  );

  if (manifests.length === 0) {
    gaps.push(
      "No replay manifest was recorded for this trial, so this bundle carries no measurement: what the trial ran, in which environment, is not here.",
    );
  }

  const digests = replays.map((r) => r.outputDigest).filter((d): d is string => d !== null);
  const replaysAgreed =
    replays.length === 0 ? null : digests.length === replays.length && new Set(digests).size === 1;
  if (replays.length > 0 && replays.length < 3) {
    gaps.push(`Only ${replays.length} of the three required replays were recorded for this trial.`);
  }
  if (replaysAgreed === false) {
    gaps.push(
      "The recorded replays did not agree on their result, so what they produced does not follow from the task.",
    );
  }

  const dimensions = (input.dimensionScores ?? []).map((score) => ({
    dimension: score.dimension,
    weightBps: Math.round(score.weight * 10000),
    scoreBps: toBps(score.score),
  }));

  if (!input.aggregate) {
    gaps.push(
      "No aggregate score was recorded for this trial, so this bundle carries no score and none of the numbers below is a grade.",
    );
  }

  const measurement: BundleMeasurement = {
    pinnedSpecDigest: input.spec?.specDigest ?? null,
    measurementKey: input.spec ? computeMeasurementKey(input.spec) : null,
    manifestIds: manifests.map(({ manifest }) => manifest.manifestId),
    replays,
    replaysAgreed,
    dimensions,
    aggregateBps: toBps(input.aggregate?.score),
    confidenceLowerBps: toBps(input.aggregate?.confidenceLower),
    confidenceUpperBps: toBps(input.aggregate?.confidenceUpper),
    sampleCount: input.aggregate?.sampleCount ?? 0,
    scoreStatus: input.aggregate?.status ?? null,
    publicationId: input.publicationId ?? null,
  };

  const body = {
    trialKey: input.trialKey,
    chain: chainFacts,
    measurement,
    gaps,
    // The chain's clock is PART of what was frozen: it is what the dispute
    // comparison is made against.
    sealedAtChainSeconds: input.sealedAtChainSeconds ?? null,
  };

  const digest = hashCanonical(body);
  return {
    id: `bundle_${digest.slice(0, 32)}`,
    ...body,
    // The seal time is NOT part of the digest, and that is deliberate: the
    // address names WHAT was frozen, so sealing the same evidence twice
    // is the same bundle rather than a growing pile of identical rows.
    // The time is recorded beside the address and is verifiable as part of
    // the row, but it is not what the address covers.
    sealedAt: input.sealedAt,
    digest,
  };
}

/**
 * Recompute a bundle's digest and say whether it matches.
 *
 * A content address that cannot be CHECKED is a label. This is the check:
 * take the bundle's substance — everything except the address, the digest
 * itself and the seal time — hash it the same way, and compare.
 *
 * It returns false for a bundle whose contents were changed after the
 * fact, which is the property the whole artefact rests on.
 */
export function verifyBundleDigest(bundle: EvidenceBundle): boolean {
  const body = {
    trialKey: bundle.trialKey,
    chain: bundle.chain,
    measurement: bundle.measurement,
    gaps: bundle.gaps,
    sealedAtChainSeconds: bundle.sealedAtChainSeconds,
  };
  const digest = hashCanonical(body);
  return digest === bundle.digest && bundle.id === `bundle_${digest.slice(0, 32)}`;
}

/* ------------------------------------------------------------------ */
/* Reading the world                                                 */
/* ------------------------------------------------------------------ */

/**
 * Gather the facts for a trial and assemble its bundle.
 *
 * The trial key is the chain's trial id as a string; the off-chain stores
 * are keyed by the platform's own trial id, and the two are the same
 * number when the platform created the trial on the chain.
 */
export async function buildBundle(
  trialKey: string,
  sealedAt: number,
  chain?: Partial<BundleChainFacts> | null,
  sealedAtChainSeconds?: number | null,
): Promise<EvidenceBundle> {
  const manifestList = await listManifestsByTrial(trialKey);
  const manifests = await Promise.all(
    manifestList.map(async (manifest) => ({
      manifest,
      replays: await listReplaysByManifest(manifest.manifestId),
    })),
  );

  const specs = listSpecsByTrial(trialKey);
  const spec = specs.length > 0 ? specs[specs.length - 1] : null;

  const runId = manifests.length > 0 ? manifests[manifests.length - 1]?.manifest.runId ?? "" : "";
  const aggregate = runId ? getAggregateScore(runId) : undefined;
  const dimensionScores = runId ? getDimensionScores(runId) : [];

  return assembleBundle({
    trialKey,
    sealedAt,
    sealedAtChainSeconds: sealedAtChainSeconds ?? null,
    chain: chain ?? null,
    spec,
    manifests,
    aggregate,
    dimensionScores,
    publicationId: null,
  });
}

/**
 * Whether this bundle is the one the parties saw before the trial was
 * broken.
 *
 * A bundle sealed after the break is not: it may contain evidence the
 * parties never saw, and a committee reading it would be deciding on a
 * record that did not exist when the dispute opened. The answer is a
 * property of two timestamps, so it can be checked by anyone.
 */
export function predatesDispute(bundle: EvidenceBundle, disputeOpenedAt: number | null): boolean | null {
  if (disputeOpenedAt === null) return null;
  // The chain's clock and the host's clock are two clocks. The seal is
  // compared against the dispute on the CHAIN's clock, because the dispute
  // happened on the chain. When this host cannot read the chain's clock,
  // the answer is "unknown" — never a guess across two clocks, which is
  // how a bundle that was sealed FIRST would come to be reported as
  // sealed LAST.
  if (bundle.sealedAtChainSeconds === null) return null;
  return bundle.sealedAtChainSeconds < disputeOpenedAt;
}
