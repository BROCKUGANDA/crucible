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
      settleBatch: async () => {
        starts.push(Date.now() - t0);
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 2_500));
        live -= 1;
        return HASH;
      },
    } as unknown as Crucible;
    const wallet = { account: null } as unknown as WalletClient;

    const warden = new Warden({ now: async () => 2_000_000_000, crucible, wallet });
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
    const settleBatch = vi.fn(async () => HASH);
    const crucible = { address: TRIALS, settleBatch } as unknown as Crucible;
    const wallet = { account: null } as unknown as WalletClient;
    const warden = new Warden({ now: async () => 2_000_000_000, crucible, wallet });

    warden.start(model, 1);
    warden.start(model, 1);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(settleBatch).toHaveBeenCalledTimes(3);

    warden.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settleBatch).toHaveBeenCalledTimes(3);

    // Restartable, which the cleared timer it replaced was too.
    warden.start(model, 1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settleBatch).toHaveBeenCalledTimes(4);
    warden.stop();
  });
});

/**
 * The batch is a throughput choice, not a correctness one. `settleBatch` aborts when the
 * chain says an entry is not settleable, because that revert is the escrow's idempotency
 * guarantee — so the warden, which is the layer that owns error isolation, has to retry the
 * trials individually rather than report the batch's failure as every trial's outcome.
 */
describe("Warden.sweep batch policy", () => {
  function twoTrialModel(): ReadModel {
    return { ...replay([]), trials: new Map([[1, row()], [2, row({ id: 2 })]]) };
  }

  it("settles the whole batch in one tx when the chain accepts it", async () => {
    const settleBatch = vi.fn(async () => HASH);
    const finalize = vi.fn(async () => HASH);
    const crucible = { address: TRIALS, settleBatch, finalize } as unknown as Crucible;
    const warden = new Warden({ now: async () => 2_000_000_000, crucible, wallet: {} as WalletClient });

    const result = await warden.sweep(twoTrialModel(), 2_000_000_000);

    expect(settleBatch).toHaveBeenCalledTimes(1);
    expect(settleBatch.mock.calls[0]?.[1]).toEqual([1n, 2n]);
    expect(finalize).not.toHaveBeenCalled();
    expect(result.acted).toHaveLength(2);
    expect(result.acted.every((a) => a.txHash === HASH && a.error === null)).toBe(true);
  });

  it("retries each trial alone when the batch is refused, and reports them separately", async () => {
    const settleBatch = vi.fn(async () => {
      throw new Error("WindowOpen");
    });
    const finalize = vi.fn(async (_wallet: unknown, id: bigint) => {
      if (id === 2n) throw new Error("AlreadySettled");
      return HASH;
    });
    const crucible = { address: TRIALS, settleBatch, finalize } as unknown as Crucible;
    const warden = new Warden({ now: async () => 2_000_000_000, crucible, wallet: {} as WalletClient });

    const result = await warden.sweep(twoTrialModel(), 2_000_000_000);

    // One trial paid for the refused batch and still settled; the other is recorded as skipped
    // with its own reason. Neither inherits the other's outcome.
    expect(settleBatch).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(2);
    const byTrial = new Map(result.acted.map((a) => [a.decision.trialId, a]));
    expect(byTrial.get(1)?.txHash).toBe(HASH);
    expect(byTrial.get(1)?.error).toBeNull();
    expect(byTrial.get(2)?.txHash).toBeNull();
    expect(byTrial.get(2)?.error).toBe("AlreadySettled");
  });

  it("never reports a tx hash for a trial the chain did not settle", async () => {
    const settleBatch = vi.fn(async () => {
      throw new Error("WindowOpen");
    });
    const finalize = vi.fn(async () => {
      throw new Error("WindowOpen");
    });
    const crucible = { address: TRIALS, settleBatch, finalize } as unknown as Crucible;
    const warden = new Warden({ now: async () => 2_000_000_000, crucible, wallet: {} as WalletClient });

    const result = await warden.sweep(twoTrialModel(), 2_000_000_000);

    expect(result.acted.every((a) => a.txHash === null)).toBe(true);
    expect(result.acted.every((a) => a.error === "WindowOpen")).toBe(true);
  });
});
