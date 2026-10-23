import { describe, expect, it } from "vitest";
import {
  DEADLINE_HEAT,
  ERROR_COPY,
  STATUS_META,
  TIER_META,
  VERDICT_META,
  deadlineHeat,
  formatDuration,
  formatEth,
  haptics,
  heatTone,
  shortCid,
  shortHash,
  statusMeta,
  tierMeta,
} from "../src/lib/forge";
import { EMPTY_WIZARD, validateWizard } from "../src/lib/wizard";

describe("tierMeta", () => {
  it("names the tiers the chain can mint", () => {
    expect(tierMeta(0).name).toBe("Unforged");
    expect(tierMeta(1).name).toBe("Iron");
    expect(tierMeta(4).name).toBe("Damascus");
  });

  it("says so when the registry could not be read", () => {
    expect(tierMeta(null).name).not.toBe("Unforged");
    expect(tierMeta(null).name).toBe("Tier unread");
  });

  it("does not publish tier 0 for a tier this bundle does not know", () => {
    // A tier the chain has moved to and the bundle has not heard of is not
    // tier 0. Rendering it as "Unforged" is a row claiming a tier it never
    // measured — the same defect the null case exists to avoid.
    expect(tierMeta(5).name).not.toBe("Unforged");
    expect(tierMeta(5).name).toBe("Tier unread");
    expect(tierMeta(99).name).toBe("Tier unread");
  });
});

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

  it("truncates a value a float would have rounded up", () => {
    // The reason this helper parses digits instead of calling Number(): 0.999999999999999999 is
    // not representable and becomes exactly 1.0, so a float path printed "1 ETH" for a balance
    // strictly below it — overstating money, which is the one thing this file exists to prevent.
    expect(formatEth("0.999999999999999999")).toBe("0.999 ETH");
    expect(formatEth("0.000999999999999999")).toBe("0.000999 ETH");
  });

  it("keeps precision above the safe-integer range", () => {
    expect(formatEth("9007199254740993.25")).toBe("9007199254740993.25 ETH");
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

describe("deadline heat", () => {
  /**
   * The assertion the old field could not pass.
   *
   * `STATUS_META[…].heat` was keyed on status, so two trials in the same state were forced to
   * read the same urgency however far apart their deadlines were. Heat is a fact about time, so
   * these tests hold it to time alone: two `judging` trials, one with two minutes left and one
   * with three days, must not colour the same way.
   */
  it("separates two trials in one status by the time they have left", () => {
    expect(deadlineHeat(120)).toBe(3);
    expect(deadlineHeat(3 * 86_400)).toBe(1);
    expect(heatTone(deadlineHeat(120))).not.toBe(heatTone(deadlineHeat(3 * 86_400)));
    // And the status itself is no longer allowed to carry one: there is nothing for it to say.
    expect(statusMeta("judging")).not.toHaveProperty("heat");
  });

  it("uses only the thresholds it is given", () => {
    expect(deadlineHeat(DEADLINE_HEAT.imminentSec)).toBe(3);
    expect(deadlineHeat(DEADLINE_HEAT.imminentSec + 1)).toBe(2);
    expect(deadlineHeat(DEADLINE_HEAT.soonSec)).toBe(2);
    expect(deadlineHeat(DEADLINE_HEAT.soonSec + 1)).toBe(1);
  });

  it("reads a passed deadline as out, not as urgent", () => {
    // ERROR_COPY's own words: "The fire's out — submission deadline passed." A trial past its
    // deadline is reclaimable rather than pressing, so it is not the hottest thing on the list.
    expect(deadlineHeat(0)).toBe(0);
    expect(deadlineHeat(-500)).toBe(0);
    expect(heatTone(deadlineHeat(-500))).toBe("dim");
  });

  it("leaves the heat unread when there is no countdown to measure", () => {
    // `deadlineEndsAt` answers null once a trial is settled, and `useCountdown` answers null for
    // a row with nothing to count down to. Colouring that as any level of heat would be the
    // page inventing a measurement — the same defect the tier table was fixed for.
    expect(deadlineHeat(null)).toBeNull();
    expect(heatTone(null)).toBe("faint");
  });

  it("never colours a countdown with the slash", () => {
    // `sear` means something already went wrong. A deadline running low means something is about
    // to, and the two must not share a colour or the list cannot be read at a glance.
    for (const remaining of [null, 0, 1, 600, 90_000, 864_000 * 30]) {
      expect(heatTone(deadlineHeat(remaining))).not.toBe("sear");
    }
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
    ).toBe("0.2");
    expect(
      validateWizard({ ...base, testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", rewardEth: "0.02" })
        .bondEth,
    ).toBe("0.01");
  });

  it("blocks the final step until everything is valid", () => {
    expect(validateWizard(EMPTY_WIZARD).ok).toBe(false);
  });
});
