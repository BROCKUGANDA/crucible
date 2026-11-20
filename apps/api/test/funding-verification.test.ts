/**
 * @file funding-verification.test.ts — a sponsor's money, read from the chain.
 *
 * The claim under test throughout: a sponsor console that says "committed 1
 * ETH" while the chain holds nothing is a claim, not a fact. These tests
 * pin the difference, and they pin the failure mode that matters most — one
 * sponsor's program presenting another sponsor's trial as its own funding.
 *
 * No chain is needed: the reader is scripted, so the tests assert the
 * DECISION, not the RPC.
 */

import { describe, it, expect } from "vitest";
import {
  verifySponsorFunding,
  summarizeFunding,
  verifiedFundingWei,
  ARENA_STATUS,
  type ChainReader,
  type ChainTrialFacts,
} from "../src/funding-verification.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

const REWARD = 1_000_000_000_000_000_000n; // 1 ETH
const FEE = 150_000_000_000_000_000n; // 15% of the reward, paid by the sponsor
const SPONSOR_FUNDING = REWARD + FEE;

function reader(overrides: Partial<ChainReader> & { facts?: ChainTrialFacts | null } = {}): ChainReader {
  const facts: ChainTrialFacts = overrides.facts ?? {
    sponsor: SPONSOR,
    reward: REWARD,
    fee: FEE,
    deposited: REWARD + FEE + 200_000_000_000_000_000n,
    paidOut: 0n,
    status: ARENA_STATUS.Open,
  };
  return {
    arenaAddress: "0xArena0000000000000000000000000000000000",
    trialCount: overrides.trialCount ?? (async () => 1n),
    trialFacts: overrides.trialFacts ?? (async () => facts),
  };
}

describe("verifySponsorFunding", () => {
  it("verifies a claim the chain confirms", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 1n,
      sponsorAddress: SPONSOR,
      claimedWei: SPONSOR_FUNDING,
      now: () => 1_700_000_000_000,
    });

    expect(receipt.verdict).toBe("verified");
    expect(receipt.reason).toBeNull();
    expect(receipt.observedSponsorFundingWei).toBe(SPONSOR_FUNDING.toString());
    expect(receipt.observedRewardWei).toBe(REWARD.toString());
    expect(receipt.observedFeeWei).toBe(FEE.toString());
    expect(receipt.checkedAt).toBe(1_700_000_000_000);
  });

  it("reads the sponsor's escrow as reward + fee, never as `deposited`", async () => {
    // `deposited` also holds the agent's bond and the skeptics' stakes.
    // Reporting it as the sponsor's money would overstate the funding by
    // every bond in the arena.
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 1n,
      sponsorAddress: SPONSOR,
      claimedWei: SPONSOR_FUNDING,
    });

    expect(receipt.observedSponsorFundingWei).not.toBe(receipt.observedDepositedWei);
    expect(BigInt(receipt.observedSponsorFundingWei!)).toBe(
      BigInt(receipt.observedRewardWei!) + BigInt(receipt.observedFeeWei!),
    );
  });

  it("rejects a claim whose amount the chain contradicts", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 1n,
      sponsorAddress: SPONSOR,
      claimedWei: SPONSOR_FUNDING + 1n,
    });

    expect(receipt.verdict).toBe("mismatch");
    expect(receipt.reason).toContain("the chain holds");
    // The chain's answer is still reported: the console needs the truth even
    // when the claim is wrong.
    expect(receipt.observedSponsorFundingWei).toBe(SPONSOR_FUNDING.toString());
  });

  it("rejects a claim about another sponsor's trial", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 1n,
      sponsorAddress: OTHER,
      claimedWei: SPONSOR_FUNDING,
    });

    expect(receipt.verdict).toBe("mismatch");
    expect(receipt.reason).toContain("was posted by");
    expect(receipt.reason).toContain("not by");
  });

  it("compares addresses case-insensitively", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 1n,
      sponsorAddress: SPONSOR.toUpperCase().replace("0X", "0x"),
      claimedWei: SPONSOR_FUNDING,
    });

    expect(receipt.verdict).toBe("verified");
  });

  it("reports a trial that does not exist as unverifiable, not as a mismatch", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 99n,
      sponsorAddress: SPONSOR,
      claimedWei: SPONSOR_FUNDING,
    });

    expect(receipt.verdict).toBe("unverifiable");
    expect(receipt.reason).toContain("no trial 99");
  });

  it("reports an unreachable chain as unverifiable, not as a sponsor who did not pay", async () => {
    const receipt = await verifySponsorFunding({
      reader: {
        arenaAddress: "0xArena0000000000000000000000000000000000",
        trialCount: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        trialFacts: async () => {
          throw new Error("unreachable");
        },
      },
      trialId: 1n,
      sponsorAddress: SPONSOR,
      claimedWei: SPONSOR_FUNDING,
    });

    expect(receipt.verdict).toBe("unverifiable");
    expect(receipt.reason).toContain("could not be read");
    expect(receipt.reason).toContain("ECONNREFUSED");
  });

  it("rejects trial id 0 — the ids start at 1", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 0n,
      sponsorAddress: SPONSOR,
      claimedWei: SPONSOR_FUNDING,
    });

    expect(receipt.verdict).toBe("unverifiable");
    expect(receipt.reason).toContain("start at 1");
  });

  it("reports a trial with no sponsor as unverifiable", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader({
        facts: {
          sponsor: ZERO,
          reward: REWARD,
          fee: FEE,
          deposited: REWARD + FEE,
          paidOut: 0n,
          status: ARENA_STATUS.Open,
        },
      }),
      trialId: 1n,
      sponsorAddress: SPONSOR,
      claimedWei: SPONSOR_FUNDING,
    });

    expect(receipt.verdict).toBe("unverifiable");
    expect(receipt.reason).toContain("no sponsor");
  });

  it("accepts a claim that names no amount once the chain confirms the sponsor", async () => {
    const receipt = await verifySponsorFunding({
      reader: reader(),
      trialId: 1n,
      sponsorAddress: SPONSOR,
    });

    expect(receipt.verdict).toBe("verified");
    expect(receipt.claimedWei).toBeNull();
  });
});

describe("summarizeFunding", () => {
  const receipt = (verdict: "verified" | "mismatch" | "unverifiable", claimed: string, observed: string | null) =>
    ({
      trialId: "1",
      sponsorAddress: SPONSOR,
      verdict,
      reason: null,
      claimedWei: claimed,
      observedSponsorFundingWei: observed,
      observedRewardWei: null,
      observedFeeWei: null,
      observedDepositedWei: null,
      observedPaidOutWei: null,
      observedSponsor: null,
      trialStatus: null,
      checkedAt: 0,
    }) as const;

  it("counts only verified receipts toward the verified total", () => {
    const receipts = [
      receipt("verified", "100", "100"),
      receipt("mismatch", "200", "50"),
      receipt("unverifiable", "300", null),
    ];

    expect(verifiedFundingWei(receipts as never)).toBe(100n);
    const summary = summarizeFunding(receipts as never);
    expect(summary.verified).toBe(1);
    expect(summary.mismatched).toBe(1);
    expect(summary.unverifiable).toBe(1);
    // The claimed total is reported alongside the verified one: their
    // difference IS the finding.
    expect(summary.claimedWei).toBe("600");
    expect(summary.verifiedWei).toBe("100");
  });

  it("reports nothing for an empty set rather than guessing", () => {
    const summary = summarizeFunding([]);
    expect(summary.checked).toBe(0);
    expect(summary.verifiedWei).toBe("0");
    expect(summary.claimedWei).toBe("0");
  });
});
