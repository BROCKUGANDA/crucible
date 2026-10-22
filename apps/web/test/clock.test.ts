import { describe, expect, it } from "vitest";
import {
  clockRead,
  deriveBooks,
  deriveClock,
  UNKNOWN,
  type ClockReads,
  type ClockRow,
} from "../src/lib/clock";

/**
 * `/clock` renders the contract's own constants. These tests are the guard that the mapping from
 * a read to a rendered sentence is right, and — the rule this repo was hunted for — that a
 * constant nobody read prints as the em dash, never as a plausible number or a reassuring zero.
 *
 * The fixture below is not "real data typed into a test to be copied to the page": it is a stand
 * for what `useReadContracts` returns when the chain answers, chosen so each derived figure has
 * one obvious expected string.
 */
const HOUR = 3600n;
const DAY = 86400n;
const FULL: ClockReads = {
  FEE_BPS: 500n,
  BPS: 10_000n,
  BOND_NUM: 1n,
  BOND_DEN: 5n,
  BREAK_STAKE_DEN: 100n,
  SLASH_SKEPTIC_NUM: 3_000n,
  MIN_BOND: 10n ** 16n, // 0.01 ether
  MAX_REWARD: 1000n * 10n ** 18n, // 1000 ether
  MIN_RUN_WINDOW: HOUR,
  MIN_BREAK_WINDOW: HOUR,
  MAX_BREAK_WINDOW: 7n * DAY,
  COMMIT_WINDOW: DAY,
  DISPUTE_TIMEOUT: 3n * DAY,
  ARGUS_THRESHOLD: 2n,
};

const at = (rows: ClockRow[], label: string): ClockRow => {
  const r = rows.find((x) => x.label === label);
  if (!r) throw new Error(`no clock row labelled "${label}"`);
  return r;
};

describe("deriveClock — the timeline", () => {
  it("formats the skeptic window as the range the contract allows", () => {
    const r = at(deriveClock(FULL).phases, "Skeptic window, set per trial");
    expect(r.value).toBe("1h 0m to 7d 0h");
    expect(r.read).toBe(true);
  });

  it("renders the commit window and dispute timeout as durations, not raw seconds", () => {
    const phases = deriveClock(FULL).phases;
    expect(at(phases, "Seat commit window").value).toBe("1d 0h");
    expect(at(phases, "Auto-settle after an un decided break").value).toBe("3d 0h");
    expect(at(phases, "Shortest submission window").value).toBe("1h 0m");
  });

  it("states the threshold as votes-of-seats from ARGUS_THRESHOLD", () => {
    expect(at(deriveClock(FULL).committee, "Votes needed to settle").value).toBe("2 of 3");
  });

  it("names the contract getter every figure came from", () => {
    expect(at(deriveClock(FULL).phases, "Seat commit window").source).toContain(
      "CrucibleTrials.COMMIT_WINDOW()",
    );
  });
});

describe("deriveBooks — the money", () => {
  it("derives every rate from the chain's own numerator and denominator", () => {
    const books = deriveBooks(FULL);
    expect(at(books, "Settlement fee, to the treasury").value).toBe("5%");
    expect(at(books, "Agent's bond, share of the reward").value).toBe("20%");
    expect(at(books, "Skeptic's minimum stake, share of the reward").value).toBe("1%");
    expect(at(books, "On a landing break: to the skeptic").value).toBe("30%");
    expect(at(books, "On a landing break: to the treasury").value).toBe("70%");
  });

  it("renders ETH ceilings through the one repo formatter", () => {
    const books = deriveBooks(FULL);
    expect(at(books, "Reward floor").value).toBe("0.01 ETH");
    expect(at(books, "Reward ceiling").value).toBe("1000 ETH");
  });
});

describe("the unknown-never-zero rule", () => {
  it("prints UNKNOWN, not 0, for a rate whose denominator was not read", () => {
    // Drop BPS: the fee, the slash split and the treasury cut all rest on it, so all three go
    // unknown rather than defaulting to a confident "0%".
    const noBps: ClockReads = { ...FULL, BPS: undefined };
    const books = deriveBooks(noBps);
    const fee = at(books, "Settlement fee, to the treasury");
    expect(fee.value).toBe(UNKNOWN);
    expect(fee.read).toBe(false);
    expect(at(books, "On a landing break: to the skeptic").value).toBe(UNKNOWN);
  });

  it("prints UNKNOWN for a duration constant that was not read", () => {
    const noCommit: ClockReads = { ...FULL, COMMIT_WINDOW: undefined };
    expect(at(deriveClock(noCommit).phases, "Seat commit window").value).toBe(UNKNOWN);
  });

  it("prints UNKNOWN for the threshold when the seats were not read", () => {
    const noArgus: ClockReads = { ...FULL, ARGUS_THRESHOLD: undefined };
    expect(at(deriveClock(noArgus).committee, "Votes needed to settle").value).toBe(UNKNOWN);
  });

  it("reports the chain as unread only when literally nothing came back", () => {
    expect(clockRead({})).toBe(false);
    expect(clockRead({ FEE_BPS: 0n })).toBe(true);
    // Every function present means the clock is fully read; `FULL` is exactly that.
    expect(clockRead(FULL)).toBe(true);
  });

  it("keeps a genuine 0 as 0, not as unknown", () => {
    // A contract that really charges no fee should print 0%, distinct from a fee that was unread.
    const zeroFee: ClockReads = { ...FULL, FEE_BPS: 0n };
    expect(at(deriveBooks(zeroFee), "Settlement fee, to the treasury").value).toBe("0%");
  });
});
