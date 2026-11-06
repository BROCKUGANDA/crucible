import { describe, expect, it } from "vitest";
import {
  assertEvaluationRecord,
  evaluationIdOf,
  verificationReportDigest,
  type EvaluationRecord,
  type Hex,
} from "@crucible/smith";
import { cid } from "@crucible/cidstore";
import { evaluationRoutes, pageEvaluations, type EvaluationSource } from "../src/evaluations.js";
import type { ContentRead } from "../src/content.js";

const FUNDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RUNNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ZERO = `0x${"00".repeat(32)}` as Hex;

interface Seed {
  trialId: number;
  agentId: number;
  runHash: Hex;
  timestamp: number;
  verdict?: "agent-wins" | "break-wins" | "abstain";
  cohortId?: string;
  score?: number;
  uncertainty?: number;
  manifestCid?: string;
}

function record(seed: Seed): EvaluationRecord {
  const verdict = seed.verdict ?? "agent-wins";
  const manifestDigestValue = `0x${(seed.trialId.toString(16) + "1".repeat(63)).slice(0, 64)}` as Hex;
  const reportDigestValue = `0x${(seed.trialId.toString(16) + "2".repeat(63)).slice(0, 64)}` as Hex;
  return assertEvaluationRecord({
    schemaVersion: 1,
    evaluationId: evaluationIdOf({ chainId: 31337, trialId: seed.trialId, runHash: seed.runHash }),
    runHash: seed.runHash,
    identity: {
      chainId: 31337,
      trialId: seed.trialId,
      agentId: seed.agentId,
      funderId: FUNDER,
      runner: RUNNER,
      transactionHash: `0x${"5d".repeat(32)}`,
      blockNumber: 400 + seed.trialId,
      timestamp: seed.timestamp,
    },
    evidence: {
      manifestCid: seed.manifestCid ?? cid(manifestText(seed.trialId)),
      manifestDigest: manifestDigestValue,
      verificationReportCid: cid(reportText(seed.trialId)),
      verificationReportDigest: reportDigestValue,
    },
    verification: {
      verdict,
      phase: verdict === "agent-wins" ? "deterministic" : "rubric",
      replayability: verdict === "agent-wins" ? "deterministic" : "partial",
      evaluatorVersion: "1.4.0",
      // `* 1000` is the whole unit story in one token: `identity.timestamp` is Unix **seconds**
      // (what a block carries) and `verifiedAt` is an ISO string, so the fixture converts. This
      // file used to hold a millisecond epoch in `timestamp` and pass `new Date(seed.timestamp)`
      // straight through — both halves agreed with each other and neither matched the chain, which
      // is exactly what `assertEvaluationRecord` now refuses.
      verifiedAt: new Date(seed.timestamp * 1000).toISOString().replace(".000Z", "Z"),
      reportVersion: 1,
    },
    ranking: {
      eligible: verdict === "agent-wins",
      exclusionReasons: verdict === "agent-wins" ? [] : [verdict === "abstain" ? "VERDICT_ABSTAIN" : "VERDICT_BREAK_WINS"],
      ...(seed.cohortId ? { cohortId: seed.cohortId } : {}),
      ...(typeof seed.score === "number" ? { score: seed.score } : {}),
      ...(typeof seed.uncertainty === "number" ? { uncertainty: seed.uncertainty } : {}),
    },
  });
}

const RUN_A = `0x${"a1".repeat(32)}` as Hex;
const RUN_B = `0x${"b2".repeat(32)}` as Hex;
const RUN_C = `0x${"c3".repeat(32)}` as Hex;

const SEEDS: Seed[] = [
  { trialId: 1, agentId: 3, runHash: RUN_A, timestamp: 1_793_923_200, cohortId: "alpha", score: 0.88, uncertainty: 0.02 },
  { trialId: 2, agentId: 4, runHash: RUN_B, timestamp: 1_793_923_300, cohortId: "alpha", score: 0.61 },
  {
    trialId: 3,
    agentId: 3,
    runHash: RUN_C,
    timestamp: 1_793_923_400,
    verdict: "abstain",
    cohortId: "beta",
  },
];

/** The bytes the fixtures pretend were pinned, so a CID in a record resolves to something. */
const manifestText = (trialId: number): string => JSON.stringify({ kind: "manifest", trialId });
const reportText = (trialId: number): string => JSON.stringify({ kind: "report", trialId });

function source(records = SEEDS.map(record)): EvaluationSource {
  const pinned = new Map<string, string>();
  for (const seed of SEEDS) {
    if (!seed.manifestCid) pinned.set(cid(manifestText(seed.trialId)), manifestText(seed.trialId));
    pinned.set(cid(reportText(seed.trialId)), reportText(seed.trialId));
  }
  return {
    records: () => records,
    history: (runHash) =>
      runHash.toLowerCase() === RUN_A.toLowerCase()
        ? [
            { cid: "bafkv1", reportVersion: 1, envelope: { reportVersion: 1 } },
            { cid: "bafkv2", reportVersion: 2, envelope: { reportVersion: 2 } },
          ]
        : [],
    lookup: (id) =>
      pinned.has(id)
        ? ({ kind: "text", text: pinned.get(id)! } satisfies ContentRead)
        : ({ kind: "unresolved", reason: "no such bytes here" } satisfies ContentRead),
  };
}

function app(withSource: EvaluationSource | null = source()) {
  return evaluationRoutes(withSource);
}

describe("GET /evaluations", () => {
  it("says it is not configured rather than showing an empty list", async () => {
    const res = await app(null).request("/");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("not configured");
  });

  it("answers newest-verified first and totals the whole set", async () => {
    const body = (await (await app().request("/")).json()) as {
      evaluations: EvaluationRecord[];
      meta: { count: number; total: number; cursor: string | null };
    };
    expect(body.meta.total).toBe(3);
    expect(body.evaluations.map((e) => e.identity.trialId)).toEqual([3, 2, 1]);
    expect(body.meta.cursor).toBeNull();
  });

  it("filters to eligible rows only when asked", async () => {
    const body = (await (await app().request("/?eligibleOnly=1")).json()) as {
      evaluations: EvaluationRecord[];
      meta: { total: number };
    };
    expect(body.evaluations.map((e) => e.identity.trialId)).toEqual([2, 1]);
    expect(body.meta.total).toBe(2);
  });

  it("filters by cohort and by agent", async () => {
    const cohort = (await (await app().request("/?cohortId=beta")).json()) as { evaluations: EvaluationRecord[] };
    expect(cohort.evaluations.map((e) => e.identity.trialId)).toEqual([3]);
    const agent = (await (await app().request("/?agentId=4")).json()) as { evaluations: EvaluationRecord[] };
    expect(agent.evaluations.map((e) => e.identity.trialId)).toEqual([2]);
  });

  /**
   * `GATE-EVAL-08` — walk every page and count.
   *
   * A cursor that is off by one shows up as a missing row or a repeat, and both look like
   * normal service to anyone who does not know the total. So the test knows the total.
   */
  it("walks the whole set without duplicates or gaps", async () => {
    const routes = app();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url = cursor === null ? "/?limit=2" : `/?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const body = (await (await routes.request(url)).json()) as {
        evaluations: EvaluationRecord[];
        meta: { cursor: string | null };
      };
      seen.push(...body.evaluations.map((e) => e.evaluationId));
      cursor = body.meta.cursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("refuses a malformed cursor and a nonsense limit rather than restarting the walk", async () => {
    expect((await app().request("/?cursor=not-a-cursor")).status).toBe(400);
    expect((await app().request("/?limit=0")).status).toBe(400);
    expect((await app().request("/?limit=99999")).status).toBe(400);
    expect((await app().request("/?agentId=abc")).status).toBe(400);
  });
});

describe("GET /evaluations/:id", () => {
  it("finds the row by evaluation id and by run hash", async () => {
    const record = source().records()[2]!;
    const byId = await app().request(`/${record.evaluationId}`);
    expect(byId.status).toBe(200);
    const byRun = await app().request(`/${RUN_C}`);
    expect(byRun.status).toBe(200);
    expect(((await byRun.json()) as { evaluation: EvaluationRecord }).evaluation.evaluationId).toBe(
      record.evaluationId,
    );
  });

  it("answers 404 for a hash that names nothing, and for a string that is not a hash", async () => {
    expect((await app().request(`/${ZERO}`)).status).toBe(404);
    expect((await app().request("/banana")).status).toBe(404);
  });
});

describe("GET /evaluations/:id/evidence", () => {
  it("returns the pinned bytes and names the digest they must match", async () => {
    const record = source().records()[0]!;
    const body = (await (await app().request(`/${record.evaluationId}/evidence`)).json()) as {
      evidence: Record<string, { state: string; digest?: string; bytes?: string }>;
    };
    expect(body.evidence.manifest?.state).toBe("ok");
    expect(body.evidence.manifest?.digest).toBe(record.evidence.manifestDigest);
    // The bytes are the pinned document itself, not a restatement of it: the reader must be
    // able to hash what came back and match it against the digest in the record.
    expect(JSON.parse(body.evidence.verificationReport?.bytes ?? "{}")).toEqual({ kind: "report", trialId: 1 });
  });

  it("keeps a storage fault apart from an absent document", async () => {
    const broken = source();
    broken.lookup = () => ({ kind: "unreadable", reason: "volume is not mounted" }) as ContentRead;
    const record = broken.records()[0]!;
    const body = (await (await app(broken).request(`/${record.evaluationId}/evidence`)).json()) as {
      evidence: Record<string, { state: string; reason?: string }>;
    };
    expect(body.evidence.manifest?.state).toBe("unreadable");
    expect(body.evidence.manifest?.reason).toContain("volume is not mounted");
  });

  it("says when the record names no content at all", async () => {
    const record = record2WithoutCids();
    const bare = source([record]);
    const body = (await (await app(bare).request(`/${record.evaluationId}/evidence`)).json()) as {
      evidence: Record<string, { state: string }>;
    };
    expect(body.evidence.manifest?.state).toBe("unresolved");
  });
});

describe("GET /evaluations/:id/history", () => {
  it("lists every published version, oldest first, and names the current one", async () => {
    const record = source().records()[0]!;
    const body = (await (await app().request(`/${record.evaluationId}/history`)).json()) as {
      versions: { reportVersion: number }[];
      current: number;
    };
    expect(body.versions.map((v) => v.reportVersion)).toEqual([1, 2]);
    expect(body.current).toBe(record.verification.reportVersion);
  });

  it("answers an empty history honestly for a run with one verification", async () => {
    const record = source().records()[1]!;
    const body = (await (await app().request(`/${record.evaluationId}/history`)).json()) as { versions: unknown[] };
    expect(body.versions).toEqual([]);
  });
});

describe("page ordering is a property of the data, not of arrival", () => {
  it("sorts regardless of the order the source yielded", () => {
    const records = SEEDS.map(record);
    const forward = pageEvaluations(records).records.map((r) => r.identity.trialId);
    const backward = pageEvaluations([...records].reverse()).records.map((r) => r.identity.trialId);
    expect(forward).toEqual(backward);
  });

  it("breaks a timestamp tie by id, so two calls cannot disagree about who is first", () => {
    const same = [
      record({ trialId: 1, agentId: 3, runHash: RUN_A, timestamp: 1_793_923_200 }),
      record({ trialId: 2, agentId: 4, runHash: RUN_B, timestamp: 1_793_923_200 }),
    ];
    const first = pageEvaluations(same).records[0]!;
    const reversed = pageEvaluations([...same].reverse()).records[0]!;
    expect(first.evaluationId).toBe(reversed.evaluationId);
  });

  it("reports a digest over the envelope it was handed, which is what the record names", () => {
    const envelope = { runHash: RUN_A, reportVersion: 1, evaluator: { name: "argus", version: "1" }, result: {}, createdAt: "2026-01-01T00:00:00Z" };
    expect(verificationReportDigest(envelope)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

function record2WithoutCids(): EvaluationRecord {
  const base = SEEDS.map(record)[0]!;
  return {
    ...base,
    evidence: { ...base.evidence, manifestCid: "", verificationReportCid: "" },
  };
}
