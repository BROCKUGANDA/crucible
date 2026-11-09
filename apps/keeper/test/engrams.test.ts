import { describe, expect, it } from "vitest";
import { emptyModel, type AgentRow, type TrialRow } from "@crucible/indexer";
import { createEngramsSync, settledTrialEvent } from "../src/engrams.js";

const OPERATOR = "0x" + "22".repeat(20);
const RUN_HASH = "0x" + "cc".repeat(32);

function modelWithTrial(over: Partial<TrialRow> = {}, withAgent = true) {
  const model = emptyModel();
  const trial: TrialRow = {
    id: 7,
    sponsor: "0x" + "11".repeat(20),
    specCID: null,
    testsCID: null,
    specDigest: "0x" + "33".repeat(32),
    testsDigest: "0x" + "55".repeat(32),
    rewardWei: 10n ** 17n,
    bondWei: 10n ** 15n,
    payoutWei: null,
    createdAt: 1_799_000_000,
    deadline: 1_800_000_000,
    breakWindow: 86_400,
    agentId: 3,
    runHash: RUN_HASH,
    runAt: 1_799_000_100,
    breakSkeptic: null,
    breakStakeWei: null,
    breakProofCID: null,
    status: "settled",
    verdict: "paid",
    disputeOpenedAt: null,
    settledAt: 1_799_000_200,
    ...over,
  };
  model.trials.set(7, trial);
  if (withAgent) {
    const agent: AgentRow = {
      id: 3,
      operator: OPERATOR,
      runner: OPERATOR,
      metadataURI: "ipfs://m",
      stakeWei: 0n,
      active: 1,
      wins: 1,
      survived: 1,
      slashes: 0,
      identityAgentId: null,
      identity: null,
      settlements: [],
    };
    model.agents.set(3, agent);
  }
  return model;
}

describe("settlement -> achievement bridge", () => {
  it("builds a deterministic verified event from the settled row", () => {
    const event = settledTrialEvent(modelWithTrial(), 7);
    expect(event).not.toBeNull();
    expect(event!.eventId).toBe(`settle:7:${RUN_HASH}`);
    expect(event!.eventType).toBe("trial.settled");
    expect(event!.verified).toBe(true);
    expect(event!.recipient).toBe(OPERATOR);
    expect(event!.operator).toBe(OPERATOR);
    expect(event!.runHash).toBe(RUN_HASH);
    expect(event!.argusVerdict).toBe("paid");
    expect(event!.timestamp).toBe(1_799_000_200_000);
  });

  it("marks a paid trial that survived a filed break as broken-survived", () => {
    const event = settledTrialEvent(
      modelWithTrial({ breakSkeptic: "0x" + "44".repeat(20) }),
      7,
    );
    expect(event!.eventType).toBe("trial.broken-survived");
  });

  it("returns null when the row cannot support an event", () => {
    expect(settledTrialEvent(modelWithTrial({ status: "judging" }), 7)).toBeNull();
    expect(settledTrialEvent(modelWithTrial({}, false), 7)).toBeNull();
    expect(settledTrialEvent(emptyModel(), 7)).toBeNull();
  });

  it("posts with the keeper bearer and never throws on failure", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sync = createEngramsSync({
      url: "http://api/engrams/evaluate",
      bearer: "k".repeat(32),
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      onLog: () => {},
    });

    const accepted = await sync.afterSettlements(modelWithTrial(), [7]);
    expect(accepted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: `Bearer ${"k".repeat(32)}`,
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.recipient).toBe(OPERATOR);
    expect(body.event.eventId).toBe(`settle:7:${RUN_HASH}`);

    const failing = createEngramsSync({
      url: "http://api/engrams/evaluate",
      bearer: "k".repeat(32),
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
      onLog: () => {},
    });
    expect(await failing.afterSettlements(modelWithTrial(), [7])).toBe(0);
  });
});
