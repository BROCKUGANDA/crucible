import { describe, expect, it } from "vitest";
import { buildEscrowView, replay, type EventLike } from "../src/index.js";

/**
 * The escrow explorer's projection (gate 838).
 *
 * The question it answers is a wallet's, not the protocol's: not "how much has moved" but
 * "where is my ETH and what do I have to do to get it". The contract holds the same ETH in
 * three states with three different exits — locked to a live trial, free collateral on an
 * agent, a settled claim — so the tests below are organised by exit, and each one asserts the
 * amount the chain actually locked rather than a number this file authored.
 *
 * Models here are built by replaying real event shapes, never by writing a row literal: a
 * hand-built row proves the projection reads the field, but not that the field is what the
 * chain's log puts there.
 */

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const SKEPTIC = "0x3333333333333333333333333333333333333333";
const OUTSIDER = "0x9999999999999999999999999999999999999999";
const TRIALS = "0x4444444444444444444444444444444444444444";

const ETH = 10n ** 18n;

function ev(eventName: string, args: Record<string, unknown>, blockNumber = 1n): EventLike {
  return { blockNumber, transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`, logIndex: 0, address: TRIALS, eventName, args };
}

/** A claimed trial: sponsor's 5 ETH reward and the agent's 1 ETH bond both in escrow. */
function claimed() {
  return replay([
    ev("TrialCreated", {
      id: 1n,
      sponsor: SPONSOR,
      specCID: "0xaa",
      testsCID: "0xbb",
      reward: 5n * ETH,
      bond: 1n * ETH,
      deadline: 1_700_000_000n,
      breakWindow: 43_200n,
    }),
    ev("AgentRegistered", {
      agentId: 1n,
      operator: OPERATOR,
      runner: OPERATOR,
      metadataURI: "ipfs://m",
      stake: 2n * ETH,
    }),
    ev("TrialClaimed", { id: 1n, agentId: 1n, bond: 1n * ETH }),
  ]);
}

describe("live locks", () => {
  it("shows the sponsor the reward it escrowed and the deadline that releases it", () => {
    const view = buildEscrowView(claimed(), SPONSOR);
    expect(view.held).toHaveLength(1);
    expect(view.held[0]).toMatchObject({ trialId: 1, role: "sponsor", kind: "reward", eth: "5" });
    expect(view.held[0].reclaimableAt).toBe(1_700_000_000);
    expect(view.heldEth).toBe("5");
  });

  it("shows the agent the bond it posted, and no exit clock, because a verdict releases it", () => {
    const view = buildEscrowView(claimed(), OPERATOR);
    expect(view.held).toHaveLength(1);
    expect(view.held[0]).toMatchObject({ role: "operator", kind: "bond", eth: "1" });
    expect(view.held[0].reclaimableAt).toBeNull();
  });

  it("counts the bond out of free stake the moment the claim moves it into escrow", () => {
    // 2 ETH registered, 1 ETH bonded: `agents[1].stake` is 1 ETH on chain, and an explorer
    // that still showed 2 would be double-counting the same wei as both a lock and a stake.
    const view = buildEscrowView(claimed(), OPERATOR);
    expect(view.stakes).toEqual([{ agentId: 1, eth: "1" }]);
    expect(view.stakedEth).toBe("1");
    expect(view.heldEth).toBe("1");
  });

  it("shows no bond lock before the trial is claimed", () => {
    const open = replay([
      ev("TrialCreated", {
        id: 1n,
        sponsor: SPONSOR,
        specCID: "0xaa",
        testsCID: "0xbb",
        reward: 5n * ETH,
        bond: 1n * ETH,
        deadline: 1_700_000_000n,
        breakWindow: 43_200n,
      }),
    ]);
    // The contract takes the bond in `claimTrial`, so an unclaimed trial has no bond anywhere.
    expect(buildEscrowView(open, OPERATOR).held).toEqual([]);
    expect(buildEscrowView(open, SPONSOR).heldEth).toBe("5");
  });

  it("shows the skeptic the stake its filed break locked", () => {
    const model = replay([
      ...[
        ev("TrialCreated", {
          id: 1n,
          sponsor: SPONSOR,
          specCID: "0xaa",
          testsCID: "0xbb",
          reward: 5n * ETH,
          bond: 1n * ETH,
          deadline: 1_700_000_000n,
          breakWindow: 43_200n,
        }),
        ev("AgentRegistered", { agentId: 1n, operator: OPERATOR, runner: OPERATOR, metadataURI: "ipfs://m", stake: 2n * ETH }),
        ev("TrialClaimed", { id: 1n, agentId: 1n, bond: 1n * ETH }),
      ],
      ev("RunSubmitted", { id: 1n, agentId: 1n, runHash: `0x${"cc".repeat(32)}` }, 11n),
      ev("BreakFiled", { id: 1n, skeptic: SKEPTIC, stake: 7n * 10n ** 17n, proofCID: "ipfs://p" }, 12n),
    ]);

    const view = buildEscrowView(model, SKEPTIC);
    expect(view.held).toHaveLength(1);
    expect(view.held[0]).toMatchObject({ role: "skeptic", kind: "break stake", eth: "0.7" });
    // A challenge has no clock: `finalize` and the reveal window decide it, not a deadline.
    expect(view.held[0].reclaimableAt).toBeNull();
  });
});

describe("settled money is not a lock", () => {
  function settled(verdict: number, payout: bigint) {
    return replay([
      ev("TrialCreated", {
        id: 1n,
        sponsor: SPONSOR,
        specCID: "0xaa",
        testsCID: "0xbb",
        reward: 5n * ETH,
        bond: 1n * ETH,
        deadline: 1_700_000_000n,
        breakWindow: 43_200n,
      }),
      ev("AgentRegistered", { agentId: 1n, operator: OPERATOR, runner: OPERATOR, metadataURI: "ipfs://m", stake: 2n * ETH }),
      ev("TrialClaimed", { id: 1n, agentId: 1n, bond: 1n * ETH }),
      ev("RunSubmitted", { id: 1n, agentId: 1n, runHash: `0x${"cc".repeat(32)}` }, 11n),
      ev("VerdictFinalized", { id: 1n, verdict, agentPayout: payout }, 12n),
    ]);
  }

  it("moves a paid trial's reward out of the lock column and into the settled list", () => {
    const view = buildEscrowView(settled(1, (95n * ETH) / 100n), OPERATOR);
    expect(view.held).toEqual([]);
    expect(view.heldEth).toBe("0");
    expect(view.settledTrialIds).toEqual([1]);
    // 2 ETH registered, 1 moved into escrow at the claim, and the paid verdict returned it:
    // the stake book is whole again, and the lock column is empty. A total of 3 here would
    // mean the explorer counted the same bond as both a live lock and free stake.
    expect(view.stakedEth).toBe("2");
  });

  it("returns the bond to the agent as stake when a trial expires", () => {
    // The reclaim path is the one a sponsor hits after a refresh with nothing settled: the
    // reward becomes a claim and the bond becomes free stake, so neither may still show as a
    // lock, and the stake must not be counted twice.
    const view = buildEscrowView(settled(3, 0n), OPERATOR);
    expect(view.held).toEqual([]);
    expect(view.settledTrialIds).toEqual([1]);
    expect(view.stakedEth).toBe("2");
  });

  it("names the trial the claim came from so a reader can trace it", () => {
    const view = buildEscrowView(settled(2, 0n), SPONSOR);
    expect(view.settledTrialIds).toEqual([1]);
    // A slash refunds the sponsor, but the refund lives in `credit[wallet]`, not in a lock.
    // The projection cannot attribute an aggregate credit to one trial, and does not try.
    expect(view.held).toEqual([]);
  });
});

describe("whose money it is", () => {
  it("matches a wallet whatever case the caller typed", () => {
    const upper = buildEscrowView(claimed(), SPONSOR.toUpperCase().replace("0X", "0x"));
    expect(upper.heldEth).toBe("5");
  });

  it("shows an unrelated wallet nothing, not even the same chain's totals", () => {
    const view = buildEscrowView(claimed(), OUTSIDER);
    expect(view.held).toEqual([]);
    expect(view.stakes).toEqual([]);
    expect(view.heldEth).toBe("0");
    expect(view.stakedEth).toBe("0");
  });

  it("lists the escrow contract only when the caller supplied its address", () => {
    expect(buildEscrowView(claimed(), SPONSOR).escrowAddress).toBeNull();
    expect(buildEscrowView(claimed(), SPONSOR, { escrowAddress: TRIALS }).escrowAddress).toBe(TRIALS);
  });
});

describe("unread is not zero", () => {
  it("leaves the withdrawable column unknown when no chain read was supplied", () => {
    expect(buildEscrowView(claimed(), SPONSOR).withdrawableEth).toBeNull();
  });

  it("prints a real zero when the chain says the wallet has nothing to claim", () => {
    expect(buildEscrowView(claimed(), SPONSOR, { withdrawableWei: 0n }).withdrawableEth).toBe("0");
  });

  it("carries the chain's credit reading through untouched", () => {
    expect(buildEscrowView(claimed(), SPONSOR, { withdrawableWei: 1234567890123456789n }).withdrawableEth).toBe(
      "1.234567890123456789",
    );
  });
});

describe("a history the index only partly saw", () => {
  it("attributes nothing to a wallet when the settlement log named no one", () => {
    // The index started after this trial was created, so the row was rebuilt from the verdict
    // alone: no sponsor, no agent, zero amounts. The hall counts it and the explorer must not
    // turn a wallet's total into a guess about a row it cannot attribute to that wallet.
    const model = replay([
      ev("AgentRegistered", { agentId: 1n, operator: OPERATOR, runner: OPERATOR, metadataURI: "ipfs://m", stake: 2n * ETH }),
      ev("VerdictFinalized", { id: 9n, verdict: 1, agentPayout: ETH }, 30n),
    ]);
    const view = buildEscrowView(model, OPERATOR);
    expect(view.settledTrialIds).toEqual([]);
    expect(view.held).toEqual([]);
    expect(view.stakedEth).toBe("2");
  });
});

describe("totals are the sum of the rows shown", () => {
  it("adds a second trial instead of replacing the first", () => {
    const model = replay([
      ...[
        ev("TrialCreated", {
          id: 1n,
          sponsor: SPONSOR,
          specCID: "0xaa",
          testsCID: "0xbb",
          reward: 5n * ETH,
          bond: 1n * ETH,
          deadline: 1_700_000_000n,
          breakWindow: 43_200n,
        }),
        ev("TrialCreated", {
          id: 2n,
          sponsor: SPONSOR,
          specCID: "0xac",
          testsCID: "0xbc",
          reward: 3n * ETH,
          bond: 1n * ETH,
          deadline: 1_800_000_000n,
          breakWindow: 43_200n,
        }),
      ],
    ]);
    const view = buildEscrowView(model, SPONSOR);
    // Ascending by trial, so the same chain always renders the same table.
    expect(view.held.map((h) => h.trialId)).toEqual([1, 2]);
    expect(view.heldEth).toBe("8");
  });

  it("keeps a sub-wei remainder exact rather than rounding it away", () => {
    const model = replay([
      ev("TrialCreated", {
        id: 1n,
        sponsor: SPONSOR,
        specCID: "0xaa",
        testsCID: "0xbb",
        reward: ETH + 1n,
        bond: 1n,
        deadline: 1_700_000_000n,
        breakWindow: 43_200n,
      }),
    ]);
    const view = buildEscrowView(model, SPONSOR);
    expect(view.held[0].eth).toBe("1.000000000000000001");
    expect(view.heldEth).toBe("1.000000000000000001");
  });
});
