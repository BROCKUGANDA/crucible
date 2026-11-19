import { describe, expect, it } from "vitest";
import {
  UNKNOWN,
  apiFailure,
  baseUnits,
  bps,
  instrumentRows,
  isDenied,
  modeBanner,
  monthlyRows,
  nextIssuerState,
  noticeRows,
  paymentRows,
  shortDigest,
  vestingSummary,
  when,
} from "@/lib/protocol/console";

/**
 * The console's mapping from a live STAMP payload to a rendered string.
 *
 * The failure this file is written against is the one this repository has been
 * hunted for: a cell that prints a plausible figure because it had to print
 * something. A portion the API did not publish is not zero tokens, and a payment
 * nobody observed is not a payment of nothing.
 */

describe("baseUnits", () => {
  it("prints an integer string exactly, grouped, without a float", () => {
    // 1e18 + 1: the value a double cannot hold, which is the reason this
    // function parses digits instead of numbers.
    expect(baseUnits("1000000000000000001")).toBe("1,000,000,000,000,000,001");
    expect(baseUnits("0")).toBe("0");
    expect(baseUnits("-2500")).toBe("-2,500");
  });

  it("refuses a decimal rather than rounding it", () => {
    // A decimal here means something upstream already crossed the boundary.
    expect(baseUnits("1.5")).toBe(UNKNOWN);
    expect(baseUnits("1e18")).toBe(UNKNOWN);
    expect(baseUnits("")).toBe(UNKNOWN);
    expect(baseUnits(null)).toBe(UNKNOWN);
    expect(baseUnits(undefined)).toBe(UNKNOWN);
  });
});

describe("bps", () => {
  it("says the percentage and the basis points", () => {
    expect(bps("500")).toBe("5% · 500 bps");
    expect(bps("2000")).toBe("20% · 2000 bps");
    expect(bps("2550")).toBe("25.50% · 2550 bps");
  });

  it("does not invent a rate it was not given", () => {
    expect(bps(null)).toBe(UNKNOWN);
    expect(bps("five hundred")).toBe(UNKNOWN);
  });
});

describe("when / shortDigest", () => {
  it("uses one ISO UTC format", () => {
    expect(when(0)).toBe("1970-01-01 00:00 UTC");
    expect(when(Number.NaN)).toBe(UNKNOWN);
    expect(when(null)).toBe(UNKNOWN);
  });

  it("shortens a digest for a cell but leaves short values alone", () => {
    expect(shortDigest("a".repeat(64))).toBe("aaaaaaaaaa…");
    expect(shortDigest("doc-1")).toBe("doc-1");
    expect(shortDigest(null)).toBe(UNKNOWN);
  });
});

describe("modeBanner", () => {
  it("says what each mode may do, and treats an unknown mode as off", () => {
    expect(modeBanner("sandbox").title).toMatch(/no legal or financial effect/i);
    expect(modeBanner("manual_review").body).toMatch(/stay off/i);
    expect(modeBanner("production").title).toMatch(/manifest matched/i);
    expect(modeBanner("disabled").tone).toBe("sear");
    expect(modeBanner("disabled").title).toMatch(/switched off/i);
    // An unread mode is not a disabled host: the page measured nothing.
    expect(modeBanner(undefined).title).toMatch(/could not be read/i);
    expect(modeBanner(null).title).toMatch(/could not be read/i);
    // A mode this build does not know is read as off, not as a licence.
    expect(modeBanner("PRODUCTION").title).toMatch(/Unknown STAMP mode/);
    expect(modeBanner("PRODUCTION").tone).toBe("sear");
  });
});

describe("nextIssuerState", () => {
  it("offers exactly the next rung of the ladder, and nothing after ACTIVE", () => {
    expect(nextIssuerState("DRAFT")).toBe("COUNSEL_REVIEW");
    expect(nextIssuerState("META_DAO_REVIEW")).toBe("LISTED");
    expect(nextIssuerState("ACTIVE")).toBeNull();
    // An unknown or missing state proposes nothing rather than guessing a start.
    expect(nextIssuerState("LEGAL_HOLD")).toBeNull();
    expect(nextIssuerState(null)).toBeNull();
  });
});

describe("instrumentRows", () => {
  const instruments = [
    {
      id: "inst-1",
      holderPartyId: "holder-1",
      status: "FUNDED",
      proRataBps: "500",
      purchasePriceMinor: "100000000",
      currency: "USDC",
      signedDocumentSha256: "a".repeat(64),
    },
    {
      id: "inst-2",
      holderPartyId: "holder-2",
      status: "DRAFT",
      proRataBps: "250",
      purchasePriceMinor: "25000000",
      currency: "USDC",
      signedDocumentSha256: null,
    },
  ];

  it("reads the portion from the frozen snapshot, not from the instrument", () => {
    const rows = instrumentRows(instruments, [
      { holderId: "holder-1", holderPortionTokens: "5000000000", effectiveProRataBps: "500" },
    ]);
    expect(rows[0]!.portion).toBe("5,000,000,000");
    // The holder with no snapshot is unknown, not zero.
    expect(rows[1]!.portion).toBe(UNKNOWN);
    expect(rows[1]!.signed).toBe("not signed");
    expect(rows[0]!.tone).toBe("cool");
    expect(rows[1]!.tone).toBe("gold");
  });

  it("prints the price in its own currency and the effective rate", () => {
    const rows = instrumentRows(instruments, [
      { holderId: "holder-1", holderPortionTokens: "1", effectiveProRataBps: "2550" },
    ]);
    expect(rows[0]!.price).toBe("100,000,000 USDC");
    expect(rows[0]!.proRata).toBe("25.50% · 2550 bps");
  });
});

describe("paymentRows", () => {
  it("distinguishes observed, verified and refused", () => {
    const rows = paymentRows([
      {
        id: "p1",
        instrumentId: "i1",
        amountBaseUnits: "100000000",
        transactionSignature: "sig",
        finalityStatus: "finalized",
        canonicalityStatus: "canonical",
      },
      {
        id: "p2",
        instrumentId: "i1",
        amountBaseUnits: "100000000",
        transactionSignature: "sig2",
        finalityStatus: "finalized",
        canonicalityStatus: "canonical",
        verifiedAt: 1,
      },
      {
        id: "p3",
        instrumentId: "i1",
        amountBaseUnits: "1",
        transactionSignature: "sig3",
        finalityStatus: "submitted",
        canonicalityStatus: "pending",
        refusalReason: "amount_mismatch",
      },
    ]);
    expect(rows.map((r) => r.state)).toEqual(["observed, unverified", "verified", "refused"]);
    expect(rows.map((r) => r.tone)).toEqual(["gold", "cool", "sear"]);
    expect(rows[0]!.amount).toBe("100,000,000");
  });
});

describe("noticeRows", () => {
  it("marks an undelivered notice past its deadline as overdue", () => {
    const now = Date.UTC(2026, 0, 31);
    const rows = noticeRows(
      [
        {
          id: "n1",
          noticeType: "TOKEN_STRUCTURING",
          effectiveAt: Date.UTC(2026, 0, 1),
          requiredDeliveryAt: Date.UTC(2026, 0, 16),
          deliveredAt: null,
          status: "PENDING",
        },
        {
          id: "n2",
          noticeType: "DELIVERY",
          effectiveAt: Date.UTC(2026, 0, 1),
          requiredDeliveryAt: Date.UTC(2026, 1, 1),
          deliveredAt: Date.UTC(2026, 0, 2),
          status: "DELIVERED",
        },
      ],
      now,
    );
    expect(rows[0]!.status).toMatch(/overdue/);
    expect(rows[0]!.tone).toBe("sear");
    expect(rows[1]!.status).toBe("DELIVERED");
    expect(rows[1]!.delivered).toBe("2026-01-02 00:00 UTC");
  });
});

describe("vesting", () => {
  const delivered = 1000n;
  const vector = [
    { index: 1, amountBaseUnits: "334", releaseAt: Date.UTC(2026, 1, 1) },
    { index: 2, amountBaseUnits: "333", releaseAt: Date.UTC(2026, 2, 1) },
    { index: 3, amountBaseUnits: "333", releaseAt: Date.UTC(2026, 3, 1) },
  ];
  const vesting = {
    deliveredAmountBaseUnits: delivered.toString(),
    months: 3,
    firstReleaseAt: vector[0]!.releaseAt,
    monthlyVector: vector,
    conserved: true,
  };

  it("sums the vector to exactly what was delivered", () => {
    const sum = vector.reduce((total, release) => total + BigInt(release.amountBaseUnits), 0n);
    expect(sum).toBe(delivered);
  });

  it("never reports a released amount the state did not publish", () => {
    const summary = vestingSummary(vesting, null);
    expect(summary.delivered).toBe("1,000");
    expect(summary.released).toBe(UNKNOWN);
    expect(summary.locked).toBe(UNKNOWN);
    expect(summary.conserved).toBe("yes");
  });

  it("marks each month released or locked against the clock", () => {
    const rows = monthlyRows(vesting, Date.UTC(2026, 1, 15));
    expect(rows.map((r) => r.released)).toEqual(["released", "locked", "locked"]);
    expect(rows[0]!.date).toBe("2026-02-01 00:00 UTC");
  });

  it("says when the schedule is finished rather than printing a date", () => {
    const summary = vestingSummary(vesting, {
      releasedBaseUnits: "1000",
      remainingLockedBaseUnits: "0",
      nextReleaseAt: null,
      fullyUnlocked: true,
    });
    expect(summary.nextRelease).toBe("none — fully released");
    expect(summary.complete).toBe("yes");
  });
});

describe("apiFailure", () => {
  it("turns each refusal into something an operator can act on", () => {
    expect(apiFailure(401, null)).toMatch(/Sign in/);
    expect(apiFailure(403, { code: "stamp_no_reviewers" })).toMatch(/No reviewer/);
    expect(apiFailure(403, { code: "stamp_holder_unbound" })).toMatch(/not bound/);
    expect(apiFailure(403, { code: "forbidden" })).toMatch(/not on the reviewer list/);
    expect(apiFailure(404, { error: "instrument not found" })).toBe("instrument not found");
    expect(apiFailure(409, { error: "held", reasons: [{ code: "reserve_exceeded" }] })).toMatch(
      /reserve_exceeded/,
    );
    expect(apiFailure(500, null)).toBe("HTTP 500");
  });

  it("treats only 401 and 403 as a denial", () => {
    expect(isDenied(401)).toBe(true);
    expect(isDenied(403)).toBe(true);
    expect(isDenied(404)).toBe(false);
  });
});
