import { describe, expect, it } from "vitest";
import { chainNowMs } from "../src/lib/chainClock";

/**
 * The anchor every chain deadline in the app is measured against.
 *
 * Both failure modes are named below, because each one produces a page that looks healthy:
 * a warped chain anchored on the wall clock lets a window lapse on screen while the contract
 * still holds it open, and an idle chain anchored on the head reports a clock from yesterday
 * and never opens anything at all.
 */
const SEC = 1000;

describe("chainNowMs", () => {
  const wallSec = 1_792_739_219;

  it("takes the wall clock when the head is older than it — an idle instant-mining chain", () => {
    // No transaction for 28 hours: the last mined block is stale, and the next one will be
    // stamped with real time, not with the old head plus one.
    const idle = wallSec - 28 * 3600;
    const anchor = chainNowMs({ now: wallSec * SEC, headTimestamp: idle })!;
    expect(anchor).toBe(wallSec * SEC);
  });

  it("takes the head when the chain has been warped ahead of the wall clock", () => {
    // The golden-path drill warps by two hours. The contract enforces against that clock, so the
    // page has to count down against it too or it offers a finalize the chain will revert.
    const warped = wallSec + 2 * 3600;
    const anchor = chainNowMs({ now: wallSec * SEC, headTimestamp: warped })!;
    expect(anchor).toBe((warped + 1) * SEC);
  });

  it("never anchors before the next block the node could stamp", () => {
    // Head and wall clock agree to the second; the next block is stamped head + 1 at the earliest.
    const equal = wallSec;
    expect(chainNowMs({ now: wallSec * SEC, headTimestamp: equal })).toBe((equal + 1) * SEC);
  });

  it("falls back to the wall clock when the index has read no block yet", () => {
    expect(chainNowMs({ now: wallSec * SEC, headTimestamp: null })).toBe(wallSec * SEC);
  });

  it("refuses to invent a clock when there is no snapshot", () => {
    // Zero here is 1970, and a countdown handed 1970 reports every deadline as already past.
    expect(chainNowMs(null)).toBeNull();
    expect(chainNowMs(undefined)).toBeNull();
  });

  it("treats an unreadable head timestamp as absent rather than as epoch", () => {
    expect(chainNowMs({ now: wallSec * SEC, headTimestamp: Number.NaN })).toBe(wallSec * SEC);
  });
});
