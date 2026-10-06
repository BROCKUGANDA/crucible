import { describe, expect, it } from "vitest";
import {
  ERROR_COPY,
  STATUS_META,
  TIER_META,
  VERDICT_META,
  formatDuration,
  formatEth,
  haptics,
  shortCid,
  shortHash,
} from "../src/lib/forge";
import { EMPTY_WIZARD, validateWizard } from "../src/lib/wizard";

describe("shortHash", () => {
  it("truncates to the copy deck's format", () => {
    const h = `0x${"a".repeat(64)}`;
    expect(shortHash(h)).toBe("0xaaaa…aaaa");
  });

  it("leaves short strings alone", () => {
    expect(shortHash("0x1234")).toBe("0x1234");
  });

  it("renders an em dash rather than undefined", () => {
    expect(shortHash(null)).toBe("—");
    expect(shortCid(undefined)).toBe("—");
  });
});

describe("shortCid", () => {
  it("shows the first 8 and last 4", () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(shortCid(cid)).toBe("bafybeig…bzdi");
  });
});

describe("formatEth", () => {
  it("drops to six decimals for dust", () => {
    expect(formatEth("0.0000123")).toBe("0.000012 ETH");
  });

  it("trims trailing zeros for normal amounts", () => {
    expect(formatEth("0.95")).toBe("0.95 ETH");
    expect(formatEth("1")).toBe("1 ETH");
  });

  it("never throws on bad input", () => {
    expect(formatEth(null)).toBe("—");
    expect(formatEth("abc")).toBe("abc");
  });
});

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3600 * 3 + 120)).toBe("3h 2m");
    expect(formatDuration(86400 * 2)).toBe("2d 0h");
  });

  it("never goes negative", () => {
    expect(formatDuration(-5)).toBe("0s");
  });

  it("renders an em dash for null", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("design tokens", () => {
  it("has a colour for every trial status", () => {
    for (const s of ["open", "assigned", "judging", "challenged", "settled"]) {
      expect(STATUS_META[s as keyof typeof STATUS_META].label.length).toBeGreaterThan(0);
    }
  });

  it("has a colour for every verdict", () => {
    for (const v of ["none", "paid", "slashed", "refunded"]) {
      expect(VERDICT_META[v as keyof typeof VERDICT_META].label).toBeTruthy();
    }
  });

  it("has five alloy tiers ending in Damascus", () => {
    expect(TIER_META).toHaveLength(5);
    expect(TIER_META[4]!.name).toBe("Damascus");
  });

  it("defines every haptic pattern", () => {
    for (const [k, v] of Object.entries(haptics)) {
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it("has operator copy for every contract error", () => {
    for (const [k, v] of Object.entries(ERROR_COPY)) {
      expect(v.length, `missing copy: ${k}`).toBeGreaterThan(0);
    }
  });
});

describe("sponsor wizard validation", () => {
  it("accepts a fully filled valid form", () => {
    const r = validateWizard({
      ...EMPTY_WIZARD,
      spec: "Implement the deposit function so the suite passes.",
      testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    });
    expect(r.errors).toEqual({});
    expect(r.ok).toBe(true);
  });

  it("rejects a too-short spec with the vagueness warning", () => {
    const r = validateWizard({ ...EMPTY_WIZARD, spec: "do it", testsCID: "x" });
    expect(r.errors.spec).toMatch(/Vague specs/);
  });

  it("rejects an invalid CID", () => {
    const r = validateWizard({ ...EMPTY_WIZARD, spec: "a".repeat(30), testsCID: "QmNope" });
    expect(r.errors.testsCID).toMatch(/valid IPFS CID/);
  });

  it("enforces the 0.01 ETH reward floor", () => {
    const r = validateWizard({
      ...EMPTY_WIZARD,
      spec: "a".repeat(30),
      testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      rewardEth: "0.001",
    });
    expect(r.errors.rewardEth).toMatch(/0.01 ETH/);
  });

  it("enforces the 1 hour minimum deadline and 1h-7d window", () => {
    const base = {
      ...EMPTY_WIZARD,
      spec: "a".repeat(30),
      testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    };
    expect(validateWizard({ ...base, deadlineHours: "0.5" }).errors.deadlineHours).toMatch(/1 hour/);
    expect(validateWizard({ ...base, breakWindowHours: "0.5" }).errors.breakWindowHours).toMatch(/1 hour and 7 days/);
    expect(validateWizard({ ...base, breakWindowHours: "200" }).errors.breakWindowHours).toMatch(/1 hour and 7 days/);
  });

  it("computes the bond as 20% of reward with the 0.01 floor", () => {
    const base = { ...EMPTY_WIZARD, spec: "a".repeat(30) };
    expect(
      validateWizard({ ...base, testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", rewardEth: "1" })
        .bondEth,
    ).toBe("0.2000");
    expect(
      validateWizard({ ...base, testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", rewardEth: "0.02" })
        .bondEth,
    ).toBe("0.0100");
  });

  it("blocks the final step until everything is valid", () => {
    expect(validateWizard(EMPTY_WIZARD).ok).toBe(false);
  });
});
