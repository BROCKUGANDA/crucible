import { describe, expect, it } from "vitest";

import { applyEvent, emptyModel, type ReadModel } from "@crucible/indexer";
import { DEFAULT_HALF_LIFE_DAYS } from "@crucible/smith";

import { createApp } from "../src/app.js";

const TRIALS = "0x5555555555555555555555555555555555555555";
const OPERATOR = "0x1111111111111111111111111111111111111111";
const DAY = 86_400;

/** A block number is what the model stores before hydration; the host maps it to a clock. */
const log = (
  blockNumber: number,
  eventName: string,
  args: Record<string, unknown>,
) => ({
  blockNumber: BigInt(blockNumber),
  transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
  logIndex: 0,
  address: TRIALS,
  eventName,
  args,
});

function modelWith(settledAtBlock: number | null, breakFiled = false): ReadModel {
  let m = emptyModel();
  m = applyEvent(m, log(1, "AgentRegistered", { agentId: 3n, operator: OPERATOR, runner: OPERATOR, metadataURI: "ipfs://m", stake: 3n * 10n ** 17n }));
  m = applyEvent(m, log(10, "TrialCreated", { id: 7n, sponsor: OPERATOR, specCID: `0x${"c3".repeat(32)}`, testsCID: `0x${"d4".repeat(32)}`, reward: 10n ** 18n, bond: 2n * 10n ** 17n, deadline: 1800000000n, breakWindow: 86400n }));
  m = applyEvent(m, log(12, "TrialClaimed", { id: 7n, agentId: 3n, bond: 2n * 10n ** 17n }));
  m = applyEvent(m, log(20, "RunSubmitted", { id: 7n, agentId: 3n, runHash: `0x${"e5".repeat(32)}` }));
  if (breakFiled) {
    m = applyEvent(m, log(21, "BreakFiled", { id: 7n, skeptic: "0x2222222222222222222222222222222222222222", proofCID: `0x${"f6".repeat(32)}`, stake: 45000000000000000n }));
  }
  m = applyEvent(m, log(30, "VerdictFinalized", { id: 7n, verdict: 1n, agentPayout: 950000000000000000n }));
  if (settledAtBlock === null) {
    // The state a legacy row would be in: settled, with no recorded settlement block.
    const row = m.trials.get(7);
    if (row) row.settledAt = null;
  } else {
    const row = m.trials.get(7);
    if (row) row.settledAt = settledAtBlock;
  }
  return m;
}

function app(model: ReadModel) {
  return createApp(
    {
      getModel: () => model,
      proofSource: { chain: "Foundry", chainId: 31337, trialsAddress: TRIALS },
      alloyState: () => ({ tier: 2, locked: true, tokenUri: "data:application/json,{}" }),
    },
    { rateLimit: false },
  );
}

describe("GET /standing/:id", () => {
  it("answers 404 for an agent the index never saw, and 400 for an id that is not one", async () => {
    const app0 = app(modelWith(1_700_000_000));
    expect((await app0.request("/standing/99")).status).toBe(404);
    expect((await app0.request("/standing/zero")).status).toBe(400);
  });

  it("returns the book, the tier and the standing in one envelope, with no success flag", async () => {
    const res = await app(modelWith(1_700_000_000)).request("/standing/3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any; meta: any };
    expect(Object.keys(body).sort()).toEqual(["data", "meta"]);

    expect(body.data.book).toEqual({ wins: 1, survived: 0, slashes: 0 });
    expect(body.data.registry).toMatchObject({ tier: 2, tierName: "Bronze", locked: true });
    expect(body.data.operator).toBe(OPERATOR);
    expect(body.data.identityAgentId).toBeNull();
    expect(body.data.standing.counted).toBe(1);
    expect(body.meta.halfLifeDays).toBe(DEFAULT_HALF_LIFE_DAYS);
    expect(body.meta.proofSource).toMatchObject({ trialsAddress: TRIALS });
  });

  it("pays a survived break the +1.50 the formula says, and shows the number it used", async () => {
    // A recent settlement: at 2023 the weight has decayed to ~1e-7 and both scores round to the
    // prior's answer, which is the honest output of the formula and useless for this comparison.
    const recent = Math.floor(Date.now() / 1000) - DAY;
    const clean = (await app(modelWith(recent)).request("/standing/3").then((r) => r.json())) as { data: { outcomes: { value: number }[] } };
    const defended = (await app(modelWith(recent, true)).request("/standing/3").then((r) => r.json())) as {
      data: { outcomes: { value: number }[]; standing: { standing: number } };
    };
    expect(clean.data.outcomes[0]!.value).toBe(1);
    expect(defended.data.outcomes[0]!.value).toBe(1.5);
    expect(defended.data.standing.standing).toBeGreaterThan(clean.data.standing.standing);
  });

  it("excludes and reports an outcome with no settlement time rather than aging it from a neighbour", async () => {
    const body = (await (await app(modelWith(null)).request("/standing/3")).json()) as { data: any; meta: any };
    expect(body.data.outcomes).toHaveLength(0);
    expect(body.data.standing.counted).toBe(0);
    expect(body.meta.settledTrials).toBe(1);
    expect(body.meta.excludedNoSettlementTime).toBe(1);
    // the score of nobody-with-no-history is the prior's answer, not a blank and not a guess
    expect(body.data.standing.standing).toBe(0);
    expect(body.data.standing.display).toBe(500);
  });

  it("shows that an old record has faded, and names the two operands nobody measured", async () => {
    // hydrated to a block time 200 days before now: the weight, not the verdict, is what shrinks
    const old = (await (await app(modelWith(1_700_000_000 - 200 * DAY)).request("/standing/3")).json()) as { data: any; meta: any };
    const fresh = (await (await app(modelWith(Math.floor(Date.now() / 1000))).request("/standing/3")).json()) as { data: any; meta: any };

    expect(old.data.standing.weightMass).toBeLessThan(fresh.data.standing.weightMass);
    expect(old.data.standing.display).toBeLessThan(fresh.data.standing.display);

    const keys = old.meta.assumptions.map((a: { key: string }) => a.key);
    expect(keys).toEqual(["difficulty", "sponsorIndependence", "exitPenalties"]);
    expect(old.meta.recordsSource).toContain("logs");
  });
});
