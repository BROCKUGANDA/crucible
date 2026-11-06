import { Hono, type Context } from "hono";
import type { EvaluationRecord } from "@crucible/smith";

/**
 * `GET /leaderboards/cohorts` — rankings among runs that are actually comparable.
 *
 * A benchmark number is only comparable to another one measured under the same task, the same
 * suite and the same judge. That is what a cohort *is* here, and it is why the routes are small:
 * the ranking is not the hard part, the refusal is. A leaderboard that would happily rank a
 * `deterministic-suite` run against a rubric-judged one is not a leaderboard, it is a
 * fabrication with a decimal point in it.
 *
 * Two limits of this slice are stated here rather than left to be discovered:
 *
 *   * rows are grouped by `ranking.cohortId`, which the projection only carries when its host
 *     supplied one. A host that has not joined runs to scorecard publications therefore
 *     answers an empty cohort list — truthfully, with `configured: true`.
 *   * the comparability test uses the cohort identity the record names. The stronger form the
 *     gate asks for — comparing `suiteDigest` and `rubricVersion` themselves, so two cohorts
 *     that merely *claim* the same name cannot be merged — needs the manifest in the record's
 *     reach, which is the host-side join named in `evaluations.ts`. Until then a cohort is
 *     trusted, not verified, and `docs/adr/0024-*.md` says so.
 */

export interface LeaderboardSource {
  records(): EvaluationRecord[];
}

interface CohortRow {
  evaluationId: string;
  agentId: number;
  runner: string;
  score: number | null;
  uncertainty: number | null;
  verdict: string;
  replayability: string;
  verifiedAt: string;
}

const MAX_PAGE = 200;

function comparable(record: EvaluationRecord): boolean {
  return record.ranking.eligible && typeof record.ranking.score === "number";
}

function cohortIds(records: EvaluationRecord[]): string[] {
  const seen = new Map<string, number>();
  for (const record of records) {
    const id = record.ranking.cohortId;
    if (typeof id !== "string" || id.length === 0) continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id]) => id);
}

function rank(records: EvaluationRecord[]): CohortRow[] {
  return records
    .filter(comparable)
    .map((r) => ({
      evaluationId: r.evaluationId,
      agentId: r.identity.agentId,
      runner: r.identity.runner,
      score: r.ranking.score ?? null,
      uncertainty: r.ranking.uncertainty ?? null,
      verdict: r.verification.verdict,
      replayability: r.verification.replayability,
      verifiedAt: r.verification.verifiedAt,
    }))
    // Highest score first; ties broken by id so two calls answer the same way.
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.evaluationId.localeCompare(b.evaluationId));
}

export function leaderboardRoutes(source: LeaderboardSource | null): Hono {
  const app = new Hono();

  const unavailable = (c: Context) =>
    c.json({ error: "the evaluation source is not configured on this host" }, 503);

  app.get("/cohorts", (c) => {
    if (!source) return unavailable(c);
    const all = source.records();
    const ids = cohortIds(all);
    return c.json({
      cohorts: ids.map((id) => {
        const rows = all.filter((r) => r.ranking.cohortId === id);
        const ranked = rank(rows);
        return {
          cohortId: id,
          runs: rows.length,
          ranked: ranked.length,
          /** Excluded rather than hidden: a reader is entitled to know the field is thin. */
          unranked: rows.length - ranked.length,
          best: ranked.at(0)?.score ?? null,
          reproducibility: {
            deterministic: rows.filter((r) => r.verification.replayability === "deterministic").length,
            partial: rows.filter((r) => r.verification.replayability === "partial").length,
            nondeterministic: rows.filter((r) => r.verification.replayability === "nondeterministic").length,
          },
        };
      }),
      meta: { count: ids.length, comparability: "cohort-name (see docs/adr/0024: suite pins not yet joined)" },
    });
  });

  app.get("/cohorts/:id", (c) => {
    if (!source) return unavailable(c);
    const id = c.req.param("id");
    if (id === undefined || id.length === 0 || id.length > 64) {
      return c.json({ error: "cohortId must be 1 to 64 characters" }, 400);
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), MAX_PAGE);
    const rows = source.records().filter((r) => r.ranking.cohortId === id);
    if (rows.length === 0) return c.json({ error: `no evaluation record names cohort ${id}` }, 404);

    // Comparing across cohorts is refused where it would actually be requested — a caller
    // asking for a second cohort beside this one. Rows are already filtered to one cohort, so
    // an internal "did the filter slip?" check would be code that cannot run; the real risk is
    // a client that thinks it is being helpful by joining two measurements, and that is what
    // this answers. Until the manifest's suite and judge pins reach the record (ADR-0024), the
    // refusal is on the name a cohort claims, not on the conditions that produced it.
    const also = c.req.query("compare");
    if (also !== undefined && also !== id) {
      return c.json(
        {
          error: "these evaluations are not comparable",
          reason: "COHORT_INCOMPATIBLE",
          cohorts: [id, also],
        },
        400,
      );
    }

    const ranked = rank(rows);
    return c.json({
      cohortId: id,
      entries: ranked.slice(0, limit),
      meta: {
        count: Math.min(ranked.length, limit),
        ranked: ranked.length,
        // Rows the leaderboard will not show, and why: an abstention or a lost break is not a
        // bad score, it is no score, and hiding them would make the field look fully measured.
        excluded: rows.length - ranked.length,
      },
    });
  });

  return app;
}
