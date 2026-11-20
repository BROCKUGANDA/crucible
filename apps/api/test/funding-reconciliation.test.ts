/**
 * @file funding-reconciliation.test.ts — the commercial ledger against the chain.
 *
 * Two things are under test and they are different:
 *
 *   1. a claim the chain contradicts is reported as a drift, and the receipt
 *      is written BEFORE the totals are computed;
 *   2. a ledger that overstates what the chain holds is reported as a drift.
 *
 * The failure mode the second one exists for: the chain confirms 0.5 ETH for
 * a program whose ledger says 1 ETH is escrowed. Nothing crashed, nothing
 * threw, and the console would have shown a number the escrow does not hold.
 */

import { describe, it, expect } from "vitest";
import { reconcileFunding } from "../src/funding-reconciliation.js";
import {
  ARENA_STATUS,
  type ChainReader,
  type ChainTrialFacts,
  type FundingReceipt,
} from "../src/funding-verification.js";
import type { FundingClaim, ProgramBudgetView } from "../src/sponsor-funding-pg.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const REWARD = 1_000_000_000_000_000_000n;
const FEE = 150_000_000_000_000_000n;
const FUNDING = REWARD + FEE;

function claim(overrides: Partial<FundingClaim> = {}): FundingClaim {
  return {
    id: "claim_1",
    programId: "prog_1",
    orgId: "org_1",
    trialId: "1",
    sponsorAddress: SPONSOR,
    claimedWei: FUNDING.toString(),
    txHash: null,
    status: "CLAIMED",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function scriptReader(facts: Record<string, ChainTrialFacts>): ChainReader {
  return {
    arenaAddress: "0xArena0000000000000000000000000000000000",
    trialCount: async () => BigInt(Object.keys(facts).length),
    trialFacts: async (id: bigint) => {
      const found = facts[id.toString()];
      if (!found) throw new Error(`no trial ${id}`);
      return found;
    },
  };
}

const OPEN_TRIAL: ChainTrialFacts = {
  sponsor: SPONSOR,
  reward: REWARD,
  fee: FEE,
  deposited: FUNDING,
  paidOut: 0n,
  status: ARENA_STATUS.Open,
};

function program(overrides: Partial<ProgramBudgetView> = {}): ProgramBudgetView {
  return {
    id: "prog_1",
    name: "Pilot program",
    status: "ACTIVE",
    depositedWei: FUNDING.toString(),
    committedWei: FUNDING.toString(),
    ...overrides,
  };
}

describe("reconcileFunding", () => {
  it("reports no drift when the chain confirms the ledger", async () => {
    const written: string[] = [];
    const report = await reconcileFunding({
      reader: scriptReader({ "1": OPEN_TRIAL }),
      listClaims: async () => [claim()],
      listPrograms: async () => [program()],
      recordReceipt: async (claimId) => {
        written.push(claimId);
        return undefined;
      },
    });

    expect(report.ran).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.verified).toBe(1);
    expect(report.drifts).toHaveLength(0);
    expect(report.verifiedWei).toBe(FUNDING.toString());
    expect(written).toEqual(["claim_1"]);
  });

  it("reports a claim the chain contradicts, and writes the receipt", async () => {
    const receipts: FundingReceipt[] = [];
    const report = await reconcileFunding({
      reader: scriptReader({ "1": OPEN_TRIAL }),
      listClaims: async () => [claim({ claimedWei: (FUNDING + 1n).toString() })],
      listPrograms: async () => [program({ depositedWei: (FUNDING + 1n).toString() })],
      recordReceipt: async (_claimId, receipt) => {
        receipts.push(receipt);
        return undefined;
      },
    });

    expect(report.mismatched).toBe(1);
    expect(report.drifts.length).toBeGreaterThanOrEqual(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].verdict).toBe("mismatch");
    // The chain's answer is preserved even when the claim was wrong.
    expect(receipts[0].observedSponsorFundingWei).toBe(FUNDING.toString());
  });

  it("reports a ledger that overstates what the chain holds", async () => {
    const report = await reconcileFunding({
      reader: scriptReader({ "1": OPEN_TRIAL }),
      listClaims: async () => [claim()],
      // The ledger says twice what the chain holds.
      listPrograms: async () => [program({ depositedWei: (FUNDING * 2n).toString() })],
      recordReceipt: async () => undefined,
    });

    const ledgerDrift = report.drifts.find((d) => d.trialId === null);
    expect(ledgerDrift).toBeDefined();
    expect(ledgerDrift!.reason).toContain("the ledger says");
    expect(ledgerDrift!.reason).toContain("the chain confirms");
  });

  it("reports an unreadable chain as unverifiable, not as a sponsor who did not pay", async () => {
    const report = await reconcileFunding({
      reader: {
        arenaAddress: "0xArena0000000000000000000000000000000000",
        trialCount: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        trialFacts: async () => OPEN_TRIAL,
      },
      listClaims: async () => [claim()],
      listPrograms: async () => [program({ depositedWei: "0" })],
      recordReceipt: async () => undefined,
    });

    expect(report.unverifiable).toBe(1);
    expect(report.mismatched).toBe(0);
    expect(report.drifts.some((d) => d.verdict === "unverifiable")).toBe(true);
  });

  it("does not claim to have run when there is no chain", async () => {
    const report = await reconcileFunding({
      reader: null,
      listClaims: async () => [claim()],
      listPrograms: async () => [program()],
      recordReceipt: async () => undefined,
    });

    expect(report.ran).toBe(false);
    expect(report.reason).toContain("no chain");
    expect(report.checked).toBe(0);
    // Not "0 drifted" — a sweep that never looked has found nothing, and
    // saying so plainly is the difference between a report and a comfort.
    expect(report.drifts).toHaveLength(0);
  });

  it("survives a claim whose trial id is not a number", async () => {
    const report = await reconcileFunding({
      reader: scriptReader({ "1": OPEN_TRIAL }),
      listClaims: async () => [claim({ trialId: "not-a-number" })],
      listPrograms: async () => [],
      recordReceipt: async () => undefined,
    });

    expect(report.checked).toBe(1);
    expect(report.unverifiable).toBe(1);
    expect(report.drifts[0].reason).toContain("could not be checked");
  });
});
