import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, toHex } from "viem";

import { applyEvent, emptyModel, type ReadModel } from "@crucible/indexer";
import { TRIALS_ABI } from "@crucible/smith";

import { createApp } from "../src/app.js";
import { makeReplaySource, type LogReader, type ReplaySourceResult } from "../src/replay.js";

const TRIALS = "0x5555555555555555555555555555555555555555";
const SPONSOR = "0x1111111111111111111111111111111111111111";
const SKEPTIC = "0x2222222222222222222222222222222222222222";
const SEAT = "0x3333333333333333333333333333333333333333";
const REWARD = 900000000000000000n;
const PAYOUT = 855000000000000000n;
const BOND = 180000000000000000n;
const BREAK = 45000000000000000n;

/**
 * The fixture is built with the ABI, not by hand. That is the whole point: the node answers
 * `data` and `topics` and nothing else, so a test reader that hands back `eventName` and `args`
 * pre-decoded is describing a transport that does not exist — which is exactly how the first
 * version of this route passed its suite and answered an empty replay on a real chain.
 */
/**
 * Encoded the way a node stores it: indexed inputs become topics, the rest become `data`.
 * Nothing here hands the route an `eventName`, because nothing a real node returns does either.
 */
const encode = (blockNumber: bigint, logIndex: number, eventName: string, args: Record<string, unknown>) => {
  const item = TRIALS_ABI.find((i) => i.type === "event" && i.name === eventName);
  if (!item || item.inputs === undefined) throw new Error(`the ABI has no event ${eventName}`);
  const plain = item.inputs.filter((p) => !("indexed" in p && p.indexed));
  const data = encodeAbiParameters(
    plain,
    plain.map((p) => args[p.name ?? ""]) as never,
  );
  return {
    blockNumber,
    logIndex,
    transactionHash: `0x${(blockNumber.toString(16) + logIndex.toString(16)).padEnd(64, "0")}` as `0x${string}`,
    data,
    topics: encodeEventTopics({ abi: TRIALS_ABI, eventName, args: args as never }).map(
      (t) => t as `0x${string}`,
    ) as readonly `0x${string}`[],
  };
};

const BEAT_LOGS = [
  encode(10n, 0, "TrialCreated", { id: 7n, sponsor: SPONSOR, specCID: `0x${"c3".repeat(32)}`, testsCID: `0x${"d4".repeat(32)}`, reward: REWARD, bond: BOND, deadline: 1800000000n, breakWindow: 86400n }),
  encode(12n, 0, "TrialClaimed", { id: 7n, agentId: 3n, bond: BOND }),
  encode(20n, 0, "RunSubmitted", { id: 7n, agentId: 3n, runHash: `0x${"e5".repeat(32)}` }),
  encode(22n, 0, "BreakFiled", { id: 7n, skeptic: SKEPTIC, proofCID: `0x${"f6".repeat(32)}`, stake: BREAK }),
  encode(23n, 0, "DisputeOpened", { id: 7n }),
  encode(24n, 0, "VoteCommitted", { id: 7n, judge: SEAT }),
  encode(30n, 0, "VerdictFinalized", { id: 7n, verdict: 1n, agentPayout: PAYOUT }),
];

/** Noise a real chain carries beside a trial's beats: an admin event, another trial, junk. */
const ADMIN = encode(9n, 0, "VerificationReceiptSet", { receipt: "0x4444444444444444444444444444444444444444" });
const OTHER_TRIAL = encode(11n, 0, "TrialCreated", { id: 9n, sponsor: SPONSOR, specCID: `0x${"a1".repeat(32)}`, testsCID: `0x${"b2".repeat(32)}`, reward: REWARD, bond: BOND, deadline: 1800000000n, breakWindow: 86400n });
const UNDECODABLE = {
  blockNumber: 31n,
  transactionHash: `0x${"9f".repeat(32)}` as `0x${string}`,
  logIndex: 0,
  data: "0xdeadbeef" as `0x${string}`,
  topics: [`0x${"77".repeat(32)}`] as readonly `0x${string}`[],
};

const ALL_LOGS = [ADMIN, ...BEAT_LOGS, OTHER_TRIAL, UNDECODABLE];

function reader(logs: typeof ALL_LOGS, head = 1000n): LogReader & { asked: Record<string, unknown>[] } {
  const asked: Record<string, unknown>[] = [];
  return {
    asked,
    getBlockNumber: async () => head,
    getLogs: async (args) => {
      asked.push(args as unknown as Record<string, unknown>);
      return logs;
    },
  };
}

function appWith(
  source: ((trialId: number) => Promise<ReplaySourceResult>) | undefined,
  model: ReadModel = emptyModel(),
) {
  return createApp(
    {
      getModel: () => model,
      proofSource: { chain: "Foundry", chainId: 31337, trialsAddress: TRIALS },
    },
    { rateLimit: false, replay: source },
  );
}

/** A read model that has met this trial — the other half of the "empty for two different
 *  reasons" distinction the route has to make. */
function modelWithTrial(id: number): ReadModel {
  return applyEvent(emptyModel(), {
    blockNumber: 10n,
    transactionHash: `0x${"aa".repeat(32)}`,
    logIndex: 0,
    address: TRIALS,
    eventName: "TrialCreated",
    args: {
      id: BigInt(id),
      sponsor: SPONSOR,
      specCID: `0x${"c3".repeat(32)}`,
      testsCID: `0x${"d4".repeat(32)}`,
      reward: REWARD,
      bond: BOND,
      deadline: 1800000000n,
      breakWindow: 86400n,
    },
  });
}

describe("the replay route", () => {
  it("answers 501 rather than an empty stage when the deployment cannot read logs", async () => {
    const res = await appWith(undefined).request("/replay/7");
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain("does not read replay logs");
  });

  it("refuses an id that is not a positive integer before touching the node", async () => {
    const r = reader(ALL_LOGS);
    const app = appWith(makeReplaySource({ reader: r, address: TRIALS }));
    for (const bad of ["abc", "0", "-3", "1e9", "7.5"]) {
      const res = await app.request(`/replay/${bad}`);
      expect(res.status).toBe(400);
    }
    expect(r.asked).toHaveLength(0);
  });

  it("decodes the node's own logs into ordered beats and reports what it left out", async () => {
    const source = makeReplaySource({ reader: reader(ALL_LOGS), address: TRIALS, windowBlocks: 500n });
    const res = await appWith(source).request("/replay/7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any; meta: any };

    expect(body.data.frames.map((f: { moment: string }) => f.moment)).toEqual([
      "posted",
      "claimed",
      "submitted",
      "broken",
      "disputed",
      "voting",
      "settled",
    ]);
    expect(body.data.summary).toMatchObject({
      verdict: "paid",
      rewardWei: "900000000000000000",
      payoutWei: "855000000000000000",
      feeWei: "45000000000000000",
    });
    expect(body.data.replayHash).toMatch(/^[0-9a-f]{64}$/);
    // 7 beats for this trial; the admin event, the other trial and the junk log are named
    expect(body.meta).toMatchObject({
      logsFound: 7,
      logsOtherEvents: 2,
      logsUndecoded: 1,
      range: { fromBlock: 500, toBlock: 1000 },
    });
    expect(body.meta.beforeWindow).toBe(false);
    expect(body.meta.source).toMatchObject({ chainId: 31337, trialsAddress: TRIALS });
  });

  it("sends the topic hint without depending on it, because the node ignores it", async () => {
    const r = reader(ALL_LOGS);
    const app = appWith(makeReplaySource({ reader: r, address: TRIALS }));
    await app.request("/replay/7");

    const asked = r.asked[0] as { address: string; topics: string[]; fromBlock: bigint; abi?: unknown };
    expect(asked.address).toBe(TRIALS);
    expect(asked.topics[1]).toBe(toHex(7n, { size: 32 }));
    expect(asked.topics[0]).toHaveLength(8);
    // Measured 2026-10-24 on the deployment's own anvil: a one-topic filter still answered all
    // 56 logs. The filter is an optimisation for nodes that honour it, never the correctness path.
    expect(asked.abi).toBeUndefined();
    expect(asked.fromBlock).toBe(0n);
  });

  it("keeps a trial it does not know with no logs at 404, and one it does know at 200", async () => {
    const empty = makeReplaySource({ reader: reader([ADMIN, UNDECODABLE]), address: TRIALS });
    const unknown = await appWith(empty).request("/replay/77");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toContain("no replay logs");

    const knownButPruned = await appWith(empty, modelWithTrial(77)).request("/replay/77");
    expect(knownButPruned.status).toBe(200);
    const body = (await knownButPruned.json()) as { data: any };
    expect(body.data.frames).toHaveLength(0);
  });

  it("says 502 when the node fails, because that is not the same fact as a trial with no history", async () => {
    const broken: LogReader = {
      getBlockNumber: async () => {
        throw new Error("connection refused");
      },
      getLogs: async () => [],
    };
    const res = await appWith(makeReplaySource({ reader: broken, address: TRIALS })).request("/replay/7");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("connection refused");
  });

  it("admits when the trial was posted before the window it searched", async () => {
    const withoutCreation = BEAT_LOGS.slice(1);
    const source = makeReplaySource({ reader: reader(withoutCreation), address: TRIALS, windowBlocks: 500n });
    const res = await appWith(source).request("/replay/7");
    const body = (await res.json()) as { data: any; meta: any };
    expect(body.data.incomplete).toBe(true);
    expect(body.meta.beforeWindow).toBe(true);
  });

  it("buckets replays tighter than the ordinary read allowance", async () => {
    const app = createApp(
      { getModel: () => emptyModel() },
      { replay: makeReplaySource({ reader: reader(ALL_LOGS), address: TRIALS }) },
    );
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await app.request("/replay/7")).status);
    expect(codes[0]).toBe(200);
    expect(codes.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
