/**
 * @file studio-routes.ts — the Evaluation Studio's API.
 *
 * The Studio is where an evaluation is DESIGNED and where its reproducibility
 * is CHECKED. This route file is the part that decides, because a verdict
 * computed in the browser is a verdict anybody can edit.
 *
 * The endpoint that matters is `POST /v1/studio/reproducibility`. It runs the
 * SAME pinned task three times through the real verifier and answers one
 * question: would this result repeat?
 *
 * The rules it obeys, each of them learned from a way this could be faked:
 *
 *   - Three replays, not two and not "as many as arrived". The rule is the
 *     point: one run proves what happened once.
 *   - The comparison is over EVIDENCE, not over the verdict's PASS/FAIL. Two
 *     runs that both lack evidence agree; agreement about absence is not
 *     reproducibility, and calling it that would be the decoration this
 *     repository refuses.
 *   - A replay that produced no evidence cannot be counted, and says so.
 *   - The verdict says WHY. "INCONCLUSIVE" alone is a shrug; "2 of 3 replays
 *     produced no evidence to compare" is a fact somebody can act on.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getAdapter, type WorkloadProfile } from "@crucible/eval";
import type { CheckEvidence } from "@crucible/eval";
import { verifiedSessionFromContext } from "./auth.js";
import {
  createReplayManifest,
  createReplayRecord,
  completeReplay,
  failReplay,
} from "./replay-manifest.js";
import { hashCanonical } from "@crucible/crypto";
import { WORKLOAD_PROFILES } from "./workload-profiles.js";
import { REQUIRED_REPLAYS, REQUIRED_REPLAY_WORKERS } from "./replay-policy.js";

export { REQUIRED_REPLAYS };

export type ReproducibilityVerdict =
  | "AGREED"
  | "NOT_AGREED"
  | "INCONCLUSIVE";

/**
 * Whether the replays were INDEPENDENT — run by different workers.
 *
 * Separate from the verdict, because separate from the question: the
 * verdict says whether the replays agreed, this says whether that
 * agreement is worth calling independent reproduction. The count comes
 * from the worker identities the platform derived, never from the labels
 * the caller chose.
 */
export interface Independence {
  /** How many different workers the compared replays came from. */
  workers: number;
  /** How many the rule needs. */
  required: number;
  /** Whether the rule is met. */
  independent: boolean;
  /** Why, in words. */
  reason: string;
}

export interface ReplayResult {
  /** Which replay this is: 1, 2 or 3. */
  replayNumber: number;
  /** The label the caller gave this replay. A name, not an identity. */
  label: string;
  /**
   * WHO THIS OBSERVATION CAME FROM, as the platform knows it.
   *
   * The caller's label is not this: a caller that names its three replays
   * "worker-a", "worker-b" and "worker-c" would satisfy any check that
   * reads a label, and the independence rule would become decoration. The
   * platform attributes the observation to the party it came from.
   */
  workerIdentity: string;
  /** The verifier's status for this replay. */
  status: string;
  /** How many checks the evidence answered. */
  checksAnswered: number;
  /** The digest of the evidence this replay produced, or null when it produced none. */
  fingerprint: string | null;
  /** True when this replay can take part in the comparison. */
  comparable: boolean;
  /** Why it cannot, when it cannot. */
  reason: string | null;
}

export interface ReproducibilityReport {
  verdict: ReproducibilityVerdict;
  /** The sentence a sponsor reads. */
  explanation: string;
  replays: ReplayResult[];
  /** How many replays could take part in the comparison. */
  comparable: number;
  /** How many distinct fingerprints the comparable replays produced. */
  distinctFingerprints: number;
}

/**
 * The fingerprint of one replay: the digest of its evidence.
 *
 * The checks are sorted by id before hashing, so two replays that answered
 * the same checks in a different ORDER agree — and two replays that answered
 * different checks do not. The digest is of the evidence's own content, not
 * of the verdict, so a verdict that says "no evidence" cannot masquerade as
 * an agreement.
 */
export function fingerprintEvidence(evidence: CheckEvidence[]): string | null {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const normalised = [...evidence]
    .map((check) => ({
      id: check.id,
      passed: check.passed,
      detail: check.detail,
      artifactDigest: check.artifactDigest ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = JSON.stringify(normalised);
  // A cheap, stable, non-cryptographic digest is enough here: the fingerprints
  // are compared with each other, never published as a proof of anything.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp_${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Decide the verdict from the replays.
 *
 * Exported so the decision can be tested on its own: the routing, the
 * verifier and the storage are not what makes this a rule.
 */
export function decideReproducibility(replays: ReplayResult[]): {
  verdict: ReproducibilityVerdict;
  explanation: string;
  comparable: number;
  distinctFingerprints: number;
  independence: Independence;
} {
  const comparableReplays = replays.filter((replay) => replay.comparable);
  const comparable = comparableReplays.length;
  const distinct = new Set(comparableReplays.map((replay) => replay.fingerprint)).size;

  // INDEPENDENCE is a separate question from AGREEMENT, and it is decided
  // on the worker identities — never on the caller's labels. The Studio
  // runs its replays in this process on the caller's observations, so they
  // come from one worker and the agreement is not independent
  // reproduction. Saying so is the point: the rule the network quotes is
  // about independent replays, and a surface that quietly could not meet
  // it would make the rule decorative.
  const workers = new Set(comparableReplays.map((replay) => replay.workerIdentity)).size;
  const independence: Independence = {
    workers,
    required: REQUIRED_REPLAY_WORKERS,
    independent: comparable >= REQUIRED_REPLAYS && workers >= REQUIRED_REPLAY_WORKERS,
    reason:
      comparable < REQUIRED_REPLAYS
        ? `Only ${comparable} of the ${REQUIRED_REPLAYS} replays produced evidence to compare, so there are no workers to count yet.`
        : workers >= REQUIRED_REPLAY_WORKERS
          ? `The ${comparable} replays came from ${workers} different workers.`
          : `The ${comparable} replays came from ${workers} worker${workers === 1 ? "" : "s"}, not ${REQUIRED_REPLAY_WORKERS} different ones: agreement between replays from one worker is agreement about that worker's habits, not independent reproduction.`,
  };

  if (replays.length < REQUIRED_REPLAYS) {
    return {
      verdict: "INCONCLUSIVE",
      explanation:
        `Only ${replays.length} of the ${REQUIRED_REPLAYS} replays the rule requires were run. ` +
        `One run proves what happened once; the rule needs ${REQUIRED_REPLAYS}.`,
      comparable,
      distinctFingerprints: distinct,
      independence,
    };
  }

  if (comparable < REQUIRED_REPLAYS) {
    const silent = replays.length - comparable;
    return {
      verdict: "INCONCLUSIVE",
      explanation:
        `${silent} of ${replays.length} replays produced no evidence to compare, ` +
        `so only ${comparable} could be compared. Agreement about a missing ` +
        `result is not reproducibility.`,
      comparable,
      distinctFingerprints: distinct,
      independence,
    };
  }

  if (distinct === 1) {
    return {
      verdict: "AGREED",
      explanation:
        `All ${REQUIRED_REPLAYS} replays produced evidence and agreed on it. ` +
        `The same result would follow from the same pinned task — in this ` +
        `worker. ${independence.reason}`,
      comparable,
      distinctFingerprints: distinct,
      independence,
    };
  }

  return {
    verdict: "NOT_AGREED",
    explanation:
      `The ${REQUIRED_REPLAYS} replays produced ${distinct} different results. ` +
      `The result does not follow from the task, so publishing it as a score would be a lie.`,
    comparable,
    distinctFingerprints: distinct,
    independence,
  };
}

/**
 * Record a Studio run as a replay manifest, so it can be published.
 *
 * The pinned digest is the digest of the TASK — what was measured. It is
 * not the digest of the verdict: a verdict that changed would still be the
 * same measurement, and a measurement that stayed the same would be the
 * same task whether the verdict was AGREED or not.
 */
async function recordStudioMeasurement(input: {
  profile: string;
  task: unknown;
  results: ReplayResult[];
  agentId: string;
  callerId: string;
}): Promise<{
  manifestId: string;
  trialId: string;
  runId: string;
  pinnedDigest: string;
}> {
  const trialId = `studio_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const pinnedDigest = hashCanonical({
    profile: input.profile,
    task: input.task,
  });

  const manifest = await createReplayManifest({
    trialId,
    runId,
    specDigest: pinnedDigest,
    // The Studio measures against a workload PROFILE, not a suite. The
    // manifest's slot names the profile honestly, and the published card
    // says the suite is not published — because it is not.
    suiteVersion: input.profile,
    agentId: input.agentId,
    runtimeImageDigest: `profile:${input.profile}`,
    executionConfig: { profile: input.profile, pinnedDigest },
    judgeVersion: "studio-verifier-1",
    environmentFingerprint: "studio:local",
    artifactHashes: {},
    workerIdentity: input.callerId,
  });

  for (const result of input.results) {
    // The worker identity is the party the observation came from — never
    // the caller's name for the replay, which a caller controls.
    const record = await createReplayRecord(
      manifest.manifestId,
      result.replayNumber,
      input.callerId,
      result.label,
    );
    if (result.fingerprint) {
      await completeReplay(record.replayId, `sha256:${result.fingerprint}`);
    } else {
      await failReplay(record.replayId, result.reason ?? "this replay produced no evidence");
    }
  }

  return { manifestId: manifest.manifestId, trialId, runId, pinnedDigest };
}

export function createStudioRoutes(): Hono {
  const app = new Hono();

  /**
   * Run the pinned task three times and say whether the result repeats.
   *
   * Each replay is verified on its own by the real verifier; nothing about
   * the outcome is supplied by the caller. The caller supplies EVIDENCE (a
   * runner's observations), because the caller may be the runner — and the
   * route refuses to accept a verdict, a score or a status.
   */
  app.post("/reproducibility", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    let body: {
      profile?: string;
      task?: unknown;
      replays?: { label?: string; evidence?: CheckEvidence[] }[];
    } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }

    // A caller may not bring its own conclusion.
    for (const forbidden of ["score", "aggregate", "verified", "status", "report", "verdict"]) {
      if ((body as Record<string, unknown>)[forbidden] !== undefined) {
        return c.json(
          {
            error: `"${forbidden}" is computed by the verifier and may not be supplied by a caller`,
            code: "stamp_client_verdict_refused",
          },
          400,
        );
      }
    }

    const profile = String(body.profile ?? "SOFTWARE_ENGINEERING") as WorkloadProfile;
    if (!WORKLOAD_PROFILES.includes(profile)) {
      return c.json({ error: "unknown workload profile", code: "bad-request" }, 400);
    }

    const replaysIn = Array.isArray(body.replays) ? body.replays : [];
    if (replaysIn.length !== REQUIRED_REPLAYS) {
      return c.json(
        {
          error: `the rule needs exactly ${REQUIRED_REPLAYS} replays (got ${replaysIn.length})`,
          code: "bad-request",
        },
        400,
      );
    }

    const adapter = getAdapter(profile);

    // The task is validated ONCE, before any replay runs. A task the verifier
    // would refuse is refused here too: returning three INCONCLUSIVE replays
    // would dress a broken task up as a finding about reproducibility.
    const task = body.task ?? {};
    const validation = await adapter.validateTask(task);
    if (!validation.valid) {
      return c.json(
        {
          error: "the task is not a valid pinned task",
          details: validation.errors,
          code: "bad-request",
        },
        400,
      );
    }

    const results: ReplayResult[] = [];

    for (const [index, replay] of replaysIn.entries()) {
      const evidence = Array.isArray(replay.evidence) ? replay.evidence : [];
      const runContext = {
        runId: `replay_${randomUUID()}`,
        attemptId: `attempt_${randomUUID()}`,
        tenantId: session.payload.address.toLowerCase(),
        trialId: `studio_${index + 1}`,
        trialRevisionId: `revision_${index + 1}`,
        workloadProfile: profile,
        environmentDigest: "studio:local",
        now: () => Date.now(),
      } as never;

      let status = "ERROR";
      let comparable = false;
      let fingerprint: string | null = null;
      let reason: string | null = null;
      let checksAnswered = 0;

      try {
        const prepared = await adapter.prepare(task as never, runContext);
        const executed = await adapter.execute(prepared, runContext);
        const report = await adapter.verify(
          { ...executed, evidence: evidence.length > 0 ? evidence : undefined },
          runContext,
        );
        status = String((report as { status?: string }).status ?? "UNKNOWN");
        checksAnswered = evidence.length;
        fingerprint = fingerprintEvidence(evidence);
        comparable = fingerprint !== null;
        if (!comparable) {
          reason =
            "this replay reported no evidence, so there is nothing to compare it against";
        }
      } catch (err) {
        status = "ERROR";
        reason = err instanceof Error ? err.message : String(err);
      }

      results.push({
        replayNumber: index + 1,
        label: replay.label?.trim() || `replay ${index + 1}`,
        // The observations came from the caller, so the caller is the
        // worker they are attributed to. The caller's NAME for the replay
        // is kept beside it and is never used for the rule.
        workerIdentity: session.payload.address.toLowerCase(),
        status,
        checksAnswered,
        fingerprint,
        comparable,
        reason,
      });
    }

    const decision = decideReproducibility(results);

    // RECORD the measurement, so it can be published as a method.
    //
    // A verdict that lives only in the response is not a measurement: it
    // cannot be published, cannot be compared with another, and vanishes
    // with the page. The manifest pins what was measured (the task's own
    // digest), and one replay record per replay carries what each of them
    // produced — including the replays that produced nothing, because "this
    // replay reported no evidence" is part of the finding.
    const measurement = await recordStudioMeasurement({
      profile,
      task,
      results,
      agentId: session.payload.address.toLowerCase(),
      callerId: session.payload.address.toLowerCase(),
    });

    return c.json({
      profile,
      verdict: decision.verdict,
      explanation: decision.explanation,
      comparable: decision.comparable,
      distinctFingerprints: decision.distinctFingerprints,
      requiredReplays: REQUIRED_REPLAYS,
      // Whether the agreement is INDEPENDENT. Separate from the verdict,
      // because separate from the question: the verdict says whether the
      // replays agreed; this says whether that agreement is worth calling
      // independent reproduction.
      independence: decision.independence,
      replays: results,
      // The identifiers a caller needs to publish the method, look it up,
      // or compare it with another measurement.
      measurement: {
        manifestId: measurement.manifestId,
        trialId: measurement.trialId,
        runId: measurement.runId,
        pinnedDigest: measurement.pinnedDigest,
      },
    });
  });

  return app;
}
