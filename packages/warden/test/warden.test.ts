import { afterEach, describe, expect, it, vi } from "vitest";
import { replay, type ReadModel, type TrialRow } from "@crucible/indexer";
import type { Crucible, WalletClient } from "@crucible/smith";
import { Warden } from "../src/warden.js";

/**
 * The interval, not the policy: `start()` used to be a `setInterval`, which fires on the wall
 * clock whether or not the previous sweep returned. A pass that outruns `everySec` got a second
 * one started on top of it, both walking the same read model and sending the same `finalize` —
 * the contract reverts the duplicate, but the node paid for both, and the nonces interleaved.
 */

const TRIALS = "0x4444444444444444444444444444444444444444";
const HASH = `0x${"cd".repeat(32)}` as `0x${string}`;

function row(over: Partial<TrialRow> = {}): TrialRow {
  return {
    id: 1,
    sponsor: "0x1111111111111111111111111111111111111111",
    specCID: null,
    testsCID: null,
    specDigest: "0xaa",
    testsDigest: "0xbb",
    rewardWei: 10n ** 18n,
    bondWei: 2n * 10n ** 17n,
    createdAt: 1,
    deadline: 4_000_000_000,
    breakWindow: 0,
    agentId: 1,
    runHash: null,
    runAt: 1,
    breakSkeptic: null,
    breakStakeWei: null,
    breakProofCID: null,
    status: "judging",
    verdict: "none",
    disputeOpenedAt: null,
    ...over,
  };
}

/** One trial whose skeptic window closed an age ago, so every pass has something to send. */
function model(): ReadModel {
  return { ...replay([]), trials: new Map([[1, row()]]) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Warden.start", () => {
  it("runs a slow sweep one at a time, and spaces passes off the previous one finishing", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const starts: number[] = [];
    let live = 0;
    let peak = 0;

    const crucible = {
      address: TRIALS,
      finalize: async () => {
        starts.push(Date.now() - t0);
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 2_500));
        live -= 1;
        return HASH;
      },
    } as unknown as Crucible;
    const wallet = { account: null } as unknown as WalletClient;

    const warden = new Warden({ crucible, wallet });
    warden.start(model, 1);

    await vi.advanceTimersByTimeAsync(20_000);
    warden.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    // 2500ms of work on a 1000ms period: a wall-clock schedule would have launched 20 passes,
    // three deep at any moment. These started one at a time, each 1s after the last returned.
    expect(peak).toBe(1);
    expect(starts).toEqual([1_000, 4_500, 8_000, 11_500, 15_000, 18_500]);
  });

  it("stop() leaves nothing scheduled, and start() twice is one loop", async () => {
    vi.useFakeTimers();
    const finalize = vi.fn(async () => HASH);
    const crucible = { address: TRIALS, finalize } as unknown as Crucible;
    const wallet = { account: null } as unknown as WalletClient;
    const warden = new Warden({ crucible, wallet });

    warden.start(model, 1);
    warden.start(model, 1);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(finalize).toHaveBeenCalledTimes(3);

    warden.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finalize).toHaveBeenCalledTimes(3);

    // Restartable, which the cleared timer it replaced was too.
    warden.start(model, 1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(finalize).toHaveBeenCalledTimes(4);
    warden.stop();
  });
});
