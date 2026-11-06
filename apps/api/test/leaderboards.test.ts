import { describe, expect, it } from "vitest";
import {
  assertEvaluationRecord,
  evaluationIdOf,
  type EvaluationExclusionReason,
  type EvaluationRecord,
  type Hex,
} from "@crucible/smith";
import { leaderboardRoutes, type LeaderboardSource } from "../src/leaderboards.js";

const FUNDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RUNNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

interface Seed {
  trialId: number;
  agentId: number;
  cohortId?: string;
  score?: number;
  uncertainty?: number;
  reasons?: EvaluationExclusionReason[];
  replayability?: "deterministic" | "partial" | "nondeterministic";
}

function record(seed: Seed): EvaluationRecord {
  const eligible = (seed.reasons ?? []).length === 0 && seed.score !== undefined;
  const runHash = `0x${seed.trialId.toString(16).padStart(2, "0").repeat(32)}`.slice(0, 66) as Hex;
  return assertEvaluationRecord({
    schemaVersion: 1,
    evaluationId: evaluationIdOf({ chainId: 31337, trialId: seed.trialId, runHash }),
    runHash,
    identity: {
      chainId: 31337,
      trialId: seed.trialId,
      agentId: seed.agentId,
      funderId: FUNDER,
      runner: RUNNER,
      transactionHash: `0x${"5d".repeat(32)}`,
      blockNumber: 400 + seed.trialId,
      timestamp: 1_793_923_200_000 + seed.trialId * 1000,
    },
    evidence: {
      manifestCid: "bafkmanifest",
      manifestDigest: `0x${"11".repeat(32)}`,
      verificationReportCid: "bafkreport",
      verificationReportDigest: `0x${"22".repeat(32)}`,
    },
    verification: {
      verdict: eligible ? "agent-wins" : "abstain",
      phase: "deterministic",
      replayability: seed.replayability ?? "deterministic",
      evaluatorVersion: "1.4.0",
      verifiedAt: "2026-11-06T04:30:00Z",
      reportVersion: 1,
    },
    ranking: {
      eligible,
      exclusionReasons: seed.reasons ?? (seed.score === undefined ? ["UNVERIFIED"] : []),
      ...(seed.cohortId ? { cohortId: seed.cohortId } : {}),
      ...(typeof seed.score === "number" ? { score: seed.score } : {}),
      ...(typeof seed.uncertainty === "number" ? { uncertainty: seed.uncertainty } : {}),
    },
  });
}

const RECORDS = [
  record({ trialId: 1, agentId: 3, cohortId: "alpha", score: 0.42 }),
  record({ trialId: 2, agentId: 4, cohortId: "alpha", score: 0.91, uncertainty: 0.03 }),
  record({ trialId: 3, agentId: 5, cohortId: "alpha", score: 0.66 }),
  record({
    trialId: 4,
    agentId: 6,
    cohortId: "alpha",
    score: 0.99,
    reasons: ["TAMPERED_EVIDENCE"],
    // Highest score in the cohort, and the least trustworthy evidence: an abstention the
    // verifier could not reproduce.
    replayability: "nondeterministic",
  }),
  record({ trialId: 5, agentId: 7, cohortId: "beta", score: 0.1, replayability: "partial" }),
  record({ trialId: 6, agentId: 8 }),
];

function source(): LeaderboardSource {
  return { records: () => RECORDS };
}

describe("GET /leaderboards/cohorts", () => {
  it("says it is not configured rather than showing no cohorts", async () => {
    const res = await leaderboardRoutes(null).request("/cohorts");
    expect(res.status).toBe(503);
  });

  it("lists each cohort once, with the ranked count beside the total", async () => {
    const body = (await (await leaderboardRoutes(source()).request("/cohorts")).json()) as {
      cohorts: { cohortId: string; runs: number; ranked: number; unranked: number; best: number | null }[];
      meta: { count: number };
    };
    expect(body.meta.count).toBe(2);
    expect(body.cohorts.map((c) => c.cohortId)).toEqual(["alpha", "beta"]);
    const alpha = body.cohorts[0]!;
    expect(alpha.runs).toBe(4);
    // The tampered row is measured and refused, not quietly dropped from the count.
    expect(alpha.ranked).toBe(3);
    expect(alpha.unranked).toBe(1);
    expect(alpha.best).toBe(0.91);
  });

  it("reports how reproducible a cohort is, because that is part of what a rank means", async () => {
    const body = (await (await leaderboardRoutes(source()).request("/cohorts")).json()) as {
      cohorts: { cohortId: string; reproducibility: Record<string, number> }[];
    };
    expect(body.cohorts[0]!.reproducibility).toEqual({ deterministic: 3, partial: 0, nondeterministic: 1 });
    expect(body.cohorts[1]!.reproducibility.partial).toBe(1);
  });

  it("ignores records that name no cohort rather than inventing one", async () => {
    const body = (await (await leaderboardRoutes(source()).request("/cohorts")).json()) as {
      meta: { count: number };
    };
    expect(body.meta.count).toBe(2);
  });
});

describe("GET /leaderboards/cohorts/:id", () => {
  it("ranks the comparable rows and puts the uncertainty beside the score", async () => {
    const body = (await (await leaderboardRoutes(source()).request("/cohorts/alpha")).json()) as {
      entries: { agentId: number; score: number; uncertainty: number | null }[];
      meta: { count: number; ranked: number; excluded: number };
    };
    expect(body.entries.map((e) => e.agentId)).toEqual([4, 5, 3]);
    expect(body.entries[0]!.uncertainty).toBe(0.03);
    expect(body.meta).toEqual({ count: 3, ranked: 3, excluded: 1 });
  });

  /**
   * The number that would win if this were a naive leaderboard.
   *
   * The tampered row scored highest of all, and it is not on the board: an excluded
   * measurement is not a bad measurement. This assertion is `GATE-EVAL-05` in disguise — if
   * eligibility ever stopped mattering to the ranking, the ordering above flips.
   */
  it("keeps an excluded row off the board even when its score is the best", async () => {
    const body = (await (await leaderboardRoutes(source()).request("/cohorts/alpha")).json()) as {
      entries: { agentId: number }[];
    };
    expect(body.entries.map((e) => e.agentId)).not.toContain(6);
  });

  it("refuses to compare two cohorts, and says which two", async () => {
    const res = await leaderboardRoutes(source()).request("/cohorts/alpha?compare=beta");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reason: string; cohorts: string[] };
    expect(body.reason).toBe("COHORT_INCOMPATIBLE");
    expect(body.cohorts).toEqual(["alpha", "beta"]);
  });

  it("answers 404 for a cohort nobody has measured, not an empty board", async () => {
    expect((await leaderboardRoutes(source()).request("/cohorts/gamma")).status).toBe(404);
  });

  it("honours a limit without pretending the rest do not exist", async () => {
    const body = (await (await leaderboardRoutes(source()).request("/cohorts/alpha?limit=2")).json()) as {
      entries: unknown[];
      meta: { count: number; ranked: number };
    };
    expect(body.entries).toHaveLength(2);
    expect(body.meta).toMatchObject({ count: 2, ranked: 3 });
  });

  it("refuses a cohort name that could not have been produced by the projection", async () => {
    expect((await leaderboardRoutes(source()).request(`/cohorts/${"x".repeat(80)}`)).status).toBe(400);
  });
});
