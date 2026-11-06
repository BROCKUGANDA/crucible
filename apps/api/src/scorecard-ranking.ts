import type { Hex } from "viem";
import type { EvaluationRankingInput } from "@crucible/indexer";
import { verifyPublications, type ScorecardRouteDeps } from "./scorecards.js";

/**
 * The run → score join, keyed on the one thing both sides already prove.
 *
 * A scorecard publication does not name a trial or a run — its signed message carries cohort,
 * chain, agent, runner, and the scorecard's own digest, and that is all
 * (`packages/smith-sdk/src/scorecard-publication.ts:26-42`). So there is no foreign key to read.
 * What there is, on both sides, is the **evaluation manifest**: a scorecard row carries its
 * manifest and its `manifestDigest`, and `verifyRows` refuses the row unless the digest recomputes
 * from the manifest it names (`apps/api/src/scorecards.ts:99-108`); a run's disclosed manifest is
 * re-hashed from its pinned bytes by the projection's own host join
 * (`apps/api/src/evaluations-source.ts`). Two independently verified numbers, same document, so
 * equality is evidence rather than a guess.
 *
 * That is also what upgrades the leaderboard's comparability claim. The gate that governs it said
 * the refusal was on the cohort's *name*, because two cohorts that merely claim the same name
 * could be merged. A manifest digest pins the task, the suite, the evaluator and its rubric, the
 * model snapshot, the seed and the thresholds — the whole list `ScorecardRow.manifestDigest`
 * documents (`grader/src/eval/types.ts:220-233`). Matching on it is matching on the conditions.
 *
 * **Three refusals, each doing real work:**
 *
 *   * No row for this agent under this digest → no score. The record carries an absent field, not
 *     a zero: a 0.0 accuracy is a measurement and a missing one is not, and inventing one here
 *     would put a number on the leaderboard that no signer ever attested.
 *   * Two *different cohorts* claim the same (agent, digest) → no score, and `COHORT_INCOMPATIBLE`
 *     as the reason. This is the ambiguous case, and picking the newer `issuedAt` would be a
 *     silent decision about comparability that nobody signed. The caller gets the reason instead
 *     of a coin flip.
 *   * Verification is not configured on this host → no score for anything, reported the same way.
 *     A leaderboard that quietly degrades to unranked rows is a leaderboard that looks empty
 *     rather than broken, and the two need different repairs.
 *
 * `uncertainty` is deliberately never filled. The scorecard row carries `n`, `consistency` and
 * `draws`, from which a confidence margin could be computed — but choosing an interval estimator
 * is a measurement decision this repository should make on purpose, with its own tests and its
 * own name, not as a side effect of a join. Absent is the honest value until then.
 */

export interface ScorecardIndexEntry {
  cohortId: string;
  score: number;
  modelId: string;
  suite: string;
}

/**
 * Build the lookup from verified publications.
 *
 * Keyed `agentId + digest`, because the same manifest scored for two agents is two different
 * measurements: `cohort` and `agentId` are both on the signed message, and neither alone
 * identifies a row.
 */
export async function buildScorecardIndex(
  deps: ScorecardRouteDeps,
): Promise<Map<string, ScorecardIndexEntry | null>> {
  const outcome = await verifyPublications(deps);
  const index = new Map<string, ScorecardIndexEntry | null>();
  if ("error" in outcome) return index;

  for (const entry of outcome.verified) {
    const cohort = entry.publication.message.cohort;
    const agentId = entry.publication.message.agentId;
    const rows = Array.isArray(entry.scorecard.rows) ? (entry.scorecard.rows as Record<string, unknown>[]) : [];
    for (const row of rows) {
      const digest = typeof row.manifestDigest === "string" ? row.manifestDigest.toLowerCase() : null;
      if (digest === null) continue;
      // Only a row that actually measured something can carry a score. A disqualified row is a
      // finding about the run, not a number to rank, and `accuracy` on it is arithmetic over a set
      // the scorer already said was invalid.
      if (row.disqualified === true) continue;
      if (typeof row.accuracy !== "number" || !Number.isFinite(row.accuracy)) continue;
      const key = `${agentId}\u0000${digest}`;
      const candidate: ScorecardIndexEntry = {
        cohortId: cohort,
        score: row.accuracy,
        modelId: String(row.modelId ?? ""),
        suite: String(row.suite ?? ""),
      };
      const held = index.get(key);
      if (held === undefined) {
        index.set(key, candidate);
      } else if (held === null) {
        // Already ambiguous; stay ambiguous.
      } else if (held.cohortId !== candidate.cohortId || held.modelId !== candidate.modelId) {
        // Two rows for one agent under one digest that do not agree on what they measured. Mark the
        // key as unresolvable rather than letting write order decide the answer.
        index.set(key, null);
      }
    }
  }
  return index;
}

/**
 * The `ranking` callback `createEvaluationSource` takes, backed by that index.
 *
 * Async work happens once, at boot, and the callback handed to the projection stays synchronous —
 * the projection runs inside routes that do, and an await in that loop would be the seam a
 * half-resolved score slips through.
 *
 * A publication that fails verification throws, and that throw is caught here rather than
 * propagated, for one specific reason: this runs while the process is starting, and one damaged
 * scorecard file would then keep the whole API from booting — including every route that has
 * nothing to do with scores. What it must not do is degrade silently. So the fault is named out
 * loud, the scoring surface goes empty (no cohort, no score, records still project), and
 * `GET /scorecards` keeps answering 500 with the same detail at request time, which is where a
 * reader is actually looking for it.
 */
export async function createScorecardRanking(
  deps: ScorecardRouteDeps,
  reportFault: (message: string) => void = (message) => console.warn(`[api] scorecard ranking disabled: ${message}`),
): Promise<(args: { agentId: number; manifestDigest: Hex | null }) => EvaluationRankingInput | null> {
  let index: Map<string, ScorecardIndexEntry | null>;
  try {
    index = await buildScorecardIndex(deps);
  } catch (err) {
    index = new Map();
    reportFault((err as Error).message);
  }
  return ({ agentId, manifestDigest }) => {
    if (manifestDigest === null) return null;
    const found = index.get(`${agentId}\u0000${manifestDigest.toLowerCase()}`);
    if (found === undefined || found === null) return null;
    return { cohortId: found.cohortId, score: found.score };
  };
}
