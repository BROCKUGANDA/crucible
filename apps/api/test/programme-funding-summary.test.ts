/**
 * @file programme-funding-summary.test.ts — the two numbers a programme is made of.
 *
 * The failure this file exists to prevent: a sponsor opens the console and
 * sees that the ledger claims 0 ETH while the chain holds 0.575 ETH, and
 * nobody can say which of the two is wrong. Two things break that:
 *
 *   - a summary built from the RECEIPTS instead of the CLAIMS, which drops
 *     every claim that has not been checked yet from the ledger's total;
 *   - a summary that lumps "never checked" in with "contradicted", which
 *     tells a sponsor the chain said no when nobody asked it.
 *
 * Both are pinned here, in the domain function the route actually calls.
 */

import { describe, it, expect } from "vitest";
import { summarizeProgrammeFunding } from "../src/funding-verification.js";

const ETH = 1_000_000_000_000_000_000n;
const REWARD = ETH;
const FEE = ETH * 15n / 100n;
const SPONSOR_FUNDING = (REWARD + FEE).toString();

describe("summarizeProgrammeFunding", () => {
  it("counts the ledger's claims from the claims, not from the receipts", () => {
    const summary = summarizeProgrammeFunding(
      [{ claimId: "c1", claimedWei: SPONSOR_FUNDING }],
      [
        {
          claimId: "c1",
          verdict: "verified",
          observedSponsorFundingWei: SPONSOR_FUNDING,
        },
      ],
    );

    // 1.15 ETH, not zero.
    expect(summary.claimedWei).toBe(SPONSOR_FUNDING);
    expect(summary.verifiedWei).toBe(SPONSOR_FUNDING);
  });

  it("keeps an unchecked claim in the ledger's total", () => {
    const summary = summarizeProgrammeFunding(
      [{ claimId: "c1", claimedWei: SPONSOR_FUNDING }],
      [],
    );

    // The claim is in the ledger and the chain has never been asked.
    expect(summary.claims).toBe(1);
    expect(summary.unchecked).toBe(1);
    expect(summary.checked).toBe(0);
    expect(summary.claimedWei).toBe(SPONSOR_FUNDING);
    // Nothing was confirmed, so no confirmed total. Zero here is a
    // measurement: no verified claim holds money.
    expect(summary.verifiedWei).toBe("0");
  });

  it("does not call an unchecked claim contradicted", () => {
    const summary = summarizeProgrammeFunding(
      [
        { claimId: "c1", claimedWei: SPONSOR_FUNDING },
        { claimId: "c2", claimedWei: SPONSOR_FUNDING },
      ],
      [{ claimId: "c1", verdict: "verified", observedSponsorFundingWei: SPONSOR_FUNDING }],
    );

    expect(summary.verified).toBe(1);
    expect(summary.mismatched).toBe(0);
    expect(summary.unverifiable).toBe(0);
    expect(summary.unchecked).toBe(1);
    // Both claims are in the ledger's number: 2.3 ETH.
    expect(summary.claimedWei).toBe((2n * (REWARD + FEE)).toString());
  });

  it("counts a claim the chain contradicted as claimed AND contradicted", () => {
    const summary = summarizeProgrammeFunding(
      [{ claimId: "c1", claimedWei: SPONSOR_FUNDING }],
      [{ claimId: "c1", verdict: "mismatch", observedSponsorFundingWei: REWARD.toString() }],
    );

    // The ledger still says 1.15 ETH. The chain said something else. Both
    // are true and both are reported.
    expect(summary.claimedWei).toBe(SPONSOR_FUNDING);
    expect(summary.mismatched).toBe(1);
    expect(summary.verified).toBe(0);
    // A contradicted claim confirms nothing, so it is not counted as money.
    expect(summary.verifiedWei).toBe("0");
  });

  it("counts a claim the chain could not read as unverifiable, not mismatched", () => {
    const summary = summarizeProgrammeFunding(
      [{ claimId: "c1", claimedWei: SPONSOR_FUNDING }],
      [{ claimId: "c1", verdict: "unverifiable", observedSponsorFundingWei: null }],
    );

    expect(summary.unverifiable).toBe(1);
    expect(summary.mismatched).toBe(0);
    expect(summary.unchecked).toBe(0);
    expect(summary.claimedWei).toBe(SPONSOR_FUNDING);
  });

  it("counts a receipt whose claim is missing from the ledger instead of dropping it", () => {
    const summary = summarizeProgrammeFunding(
      [],
      [{ claimId: "orphan", verdict: "verified", observedSponsorFundingWei: SPONSOR_FUNDING }],
    );

    expect(summary.verified).toBe(1);
    expect(summary.verifiedWei).toBe(SPONSOR_FUNDING);
    // Nothing was claimed in the ledger, so nothing is claimed.
    expect(summary.claimedWei).toBe("0");
  });
});
