import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALLOCATION_BANDS,
  BOUNDARIES,
  DELIVERY_CHECKS,
  LOCKUP_TEXT,
  RESERVE_CAP_TEXT,
  UNKNOWN,
  evidenceSentence,
  formatBps,
  formatCount,
  formatTokenAmount,
  modeView,
  publicFacts,
} from "@/lib/protocol/view";

describe("a figure is read or it is not shown", () => {
  it("renders an em dash for an unknown basis-point figure", () => {
    expect(formatBps(null)).toBe(UNKNOWN);
    expect(formatBps(undefined)).toBe(UNKNOWN);
    expect(formatBps("")).toBe(UNKNOWN);
  });

  it("renders zero as zero, because zero is a measurement", () => {
    expect(formatBps("0")).toBe("0.00% · 0 bps");
  });

  it("keeps the chain's own unit beside the percentage", () => {
    expect(formatBps("500")).toBe("5.00% · 500 bps");
    expect(formatBps("2000")).toBe("20.00% · 2000 bps");
    expect(formatBps("1234")).toBe("12.34% · 1234 bps");
  });

  it("refuses a figure that is not an integer of basis points", () => {
    expect(formatBps("5%")).toBe(UNKNOWN);
    expect(formatBps("1.5")).toBe(UNKNOWN);
  });

  it("groups a token amount on the digit string, not through a double", () => {
    // 2^53 + 1 is not representable as a double; Number() would round it.
    expect(formatTokenAmount("9007199254740993")).toBe("9,007,199,254,740,993");
    expect(formatTokenAmount("1000000")).toBe("1,000,000");
    expect(formatTokenAmount(null)).toBe(UNKNOWN);
    expect(formatTokenAmount("1e9")).toBe(UNKNOWN);
  });

  it("never renders an unmeasured count as zero", () => {
    expect(formatCount(null)).toBe(UNKNOWN);
    expect(formatCount(undefined)).toBe(UNKNOWN);
    expect(formatCount(0)).toBe("0");
    expect(formatCount(7)).toBe("7");
  });
});

describe("the mode is read, and it fails closed", () => {
  it("treats an unrecognised mode as unknown, not production", () => {
    const view = modeView({ mode: "prod" } as never);
    expect(view.mode).toBe("unknown");
    expect(view.offered).toBe(false);
    expect(view.productionUnlocked).toBe(false);
  });

  it("treats no answer as not offered", () => {
    const view = modeView(null);
    expect(view.mode).toBe("unknown");
    expect(view.offered).toBe(false);
  });

  it("says sandbox is not a legal agreement", () => {
    const view = modeView({ mode: "sandbox" });
    expect(view.offered).toBe(true);
    expect(view.notice).toMatch(/not a legal agreement|no money moves/i);
  });

  it("refuses to unlock production without a matched manifest", () => {
    const view = modeView({ mode: "production", production: { unlocked: false, reason: "tokenMint: expected a, live b" } });
    expect(view.productionUnlocked).toBe(false);
    expect(view.note).toMatch(/tokenMint/);
  });

  it("unlocks production only when the manifest matched", () => {
    const view = modeView({ mode: "production", production: { unlocked: true } });
    expect(view.productionUnlocked).toBe(true);
    expect(view.notice).toMatch(/manifest matches/i);
  });

  it("keeps manual review closed for irreversible actions", () => {
    const view = modeView({ mode: "manual_review" });
    expect(view.offered).toBe(true);
    expect(view.productionUnlocked).toBe(false);
    expect(view.notice).toMatch(/stay closed|closed/i);
  });
});

describe("the public projection", () => {
  it("shows an em dash for every figure when no issuer is published", () => {
    const facts = publicFacts(null);
    expect(facts.empty).toBe(true);
    for (const value of [
      facts.legalEntityName,
      facts.jurisdictionCode,
      facts.status,
      facts.totalNetworkTokens,
      facts.investorReserve,
      facts.tokenMint,
      facts.daoTreasury,
      facts.holders,
      facts.allocated,
    ]) {
      expect(value).toBe(UNKNOWN);
    }
  });

  it("shows the issuer's published facts and no holder data", () => {
    const facts = publicFacts({
      transparency: {
        issuer: { legalEntityName: "Crucible Protocol Issuer", jurisdictionCode: "US-DE", status: "ACTIVE" },
        totalNetworkTokens: "1000000000",
        investorReserveBps: "500",
        tokenMint: "MINT",
        holderCount: 0,
        allocatedCount: 1,
      },
    });
    expect(facts.empty).toBe(false);
    expect(facts.legalEntityName).toBe("Crucible Protocol Issuer");
    expect(facts.totalNetworkTokens).toBe("1,000,000,000");
    expect(facts.investorReserve).toBe("5.00% · 500 bps");
    // A measured zero holder count renders as 0; an absent team figure stays unknown.
    expect(facts.holders).toBe("0");
    expect(facts.teamAllocation).toBe(UNKNOWN);

    // The projection's own type has no field that could carry a holder's name or
    // purchase price, and the serialised output must not acquire one.
    expect(JSON.stringify(facts)).not.toMatch(/displayName|purchasePrice|principal/i);
  });
});

describe("the evidence sentence", () => {
  it("distinguishes a runner verdict from a trusted caller's", () => {
    expect(evidenceSentence("runner")).toMatch(/runner's observations/);
    expect(evidenceSentence("client")).toMatch(/demo mode/);
    expect(evidenceSentence("none")).toMatch(/no verdict and no score/);
  });

  it("is unknown for a source it has never seen", () => {
    expect(evidenceSentence(undefined)).toBe(UNKNOWN);
  });
});

describe("the page's own copy is bound to the domain", () => {
  const page = readFileSync(fileURLToPath(new URL("../src/app/protocol/page.tsx", import.meta.url)), "utf8");

  it("states the 20% cap in both units", () => {
    expect(RESERVE_CAP_TEXT).toContain("20%");
    expect(RESERVE_CAP_TEXT).toContain("2000 bps");
    expect(page).toContain("RESERVE_CAP_TEXT");
  });

  it("anchors the lock-up on the delivery date and Pacific time", () => {
    expect(LOCKUP_TEXT).toMatch(/first day of the month after the delivery date/);
    expect(LOCKUP_TEXT).toMatch(/Pacific/);
  });

  it("keeps the team band at 10–40% in the copy", () => {
    const band = ALLOCATION_BANDS.join(" ");
    expect(band).toContain("1000 bps");
    expect(band).toContain("4000 bps");
  });

  it("names the boundaries the routes enforce", () => {
    const text = BOUNDARIES.join(" ");
    expect(text).toMatch(/not a trial reward/);
    expect(text).toMatch(/not an Engram/);
    expect(text).toMatch(/no chain key/);
    expect(text).toMatch(/not interchangeable/);
  });

  it("lists the delivery checks a submitted transaction does not satisfy", () => {
    expect(DELIVERY_CHECKS.length).toBeGreaterThanOrEqual(6);
    expect(DELIVERY_CHECKS.join(" ")).toMatch(/base unit/);
    expect(DELIVERY_CHECKS.join(" ")).toMatch(/finality/);
  });

  it("renders the em dash rule to the reader rather than only applying it", () => {
    expect(page).toMatch(/never means zero/);
  });

  it("bans the builder's vocabulary from the money sentences", () => {
    // A visitor should not have to learn the implementation's words to read a
    // page about their own agreement.
    expect(page).not.toMatch(/CANONICALITY_STATUS|coOption|lamports/);
  });

  it("carries the ids the site descriptor points at", () => {
    for (const id of [
      "protocol-ownership",
      "protocol-public",
      "protocol-bands",
      "protocol-delivery",
      "protocol-boundaries",
      "protocol-doors",
      "protocol-vesting",
      "protocol-numbers",
    ]) {
      expect(page).toContain(`id="${id}"`);
    }
  });
});