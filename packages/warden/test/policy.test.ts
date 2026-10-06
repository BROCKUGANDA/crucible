import { describe, expect, it, vi } from "vitest";
import { replay, type EventLike, type TrialRow } from "@crucible/indexer";
import { Crucible, type WalletClient } from "@crucible/smith";
import { Warden, decide, decideAll, notifications, notifyAll, webhookNotifier } from "../src/index.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const TRIALS = "0x4444444444444444444444444444444444444444";

function ev(eventName: string, args: Record<string, unknown>): EventLike {
  return {
    blockNumber: 1n,
    transactionHash: "0x" + "11".repeat(32),
    logIndex: 0,
    address: TRIALS,
    eventName,
    args,
  };
}

const NOW = 1_700_000_000;

function row(over: Partial<TrialRow> = {}): TrialRow {
  return {
    id: 1,
    sponsor: SPONSOR,
    specCID: null,
    testsCID: null,
    specDigest: "0xaa",
    testsDigest: "0xbb",
    rewardWei: 10n ** 18n,
    bondWei: 2n * 10n ** 17n,
    createdAt: NOW - 1000,
    deadline: NOW + 1000,
    breakWindow: 43200,
    agentId: 1,
    runHash: null,
    runAt: null,
    breakSkeptic: null,
    breakStakeWei: null,
    breakProofCID: null,
    status: "open",
    verdict: "none",
    disputeOpenedAt: null,
    ...over,
  };
}

describe("decide", () => {
  it("does nothing for an open trial", () => {
    expect(decide(row({ status: "open" }), NOW).action).toBe("wait");
  });

  it("does nothing for a settled trial", () => {
    expect(decide(row({ status: "settled", verdict: "paid" }), NOW).action).toBe("wait");
  });

  it("waits while the break window is open", () => {
    const d = decide(row({ status: "judging", runAt: NOW - 10 }), NOW);
    expect(d.action).toBe("wait");
    expect(d.reason).toBe("break-window-expired");
    // runAt + breakWindow + graceSec - now
    expect(d.waitSec).toBe(43200 + 30 - 10);
  });

  it("finalizes once the break window closes", () => {
    const d = decide(row({ status: "judging", runAt: NOW - 43200 - 31 }), NOW);
    expect(d.action).toBe("finalize");
    expect(d.waitSec).toBe(0);
  });

  it("respects the grace period so a reorg cannot trigger an early tx", () => {
    const d = decide(row({ status: "judging", runAt: NOW - 43200 }), NOW);
    expect(d.action).toBe("wait");
    expect(d.waitSec).toBe(30);
  });

  it("waits for a dispute to time out, not merely for the break window", () => {
    // break window long gone, but the dispute clock is still running
    const d = decide(
      row({ status: "challenged", runAt: NOW - 500_000, disputeOpenedAt: NOW - 100 }),
      NOW,
    );
    expect(d.action).toBe("wait");
    expect(d.reason).toBe("dispute-timeout");
  });

  it("finalizes after the dispute timeout", () => {
    const d = decide(
      row({ status: "challenged", disputeOpenedAt: NOW - 3 * 24 * 3600 - 31 }),
      NOW,
    );
    expect(d.action).toBe("finalize");
    expect(d.reason).toBe("dispute-timeout");
  });

  it("reclaims rather than finalizes when a claimed trial never got a run", () => {
    // finalize() would revert with NotFinalizable on an Assigned trial
    const d = decide(row({ status: "assigned", deadline: NOW - 31 }), NOW);
    expect(d.action).toBe("reclaim");
  });

  it("waits while an assigned trial is still inside its deadline", () => {
    const d = decide(row({ status: "assigned", deadline: NOW + 500 }), NOW);
    expect(d.action).toBe("wait");
    expect(d.waitSec).toBe(530);
  });
});

describe("decideAll", () => {
  it("returns only trials with something to do", () => {
    const model = replay([
      ev("TrialCreated", {
        id: 1n, sponsor: SPONSOR, specCID: "0xaa", testsCID: "0xbb",
        reward: 1n, bond: 1n, deadline: BigInt(NOW + 1000), breakWindow: 43200n,
      }),
      ev("TrialCreated", {
        id: 2n, sponsor: SPONSOR, specCID: "0xaa", testsCID: "0xbb",
        reward: 1n, bond: 1n, deadline: BigInt(NOW + 1000), breakWindow: 43200n,
      }),
    ]);
    expect(decideAll(model, NOW)).toHaveLength(0);
  });
});

describe("notifications", () => {
  it("announces an open break window and warns before it closes", () => {
    const r = notifications(
      { ...replay([]), trials: new Map([[1, row({ status: "judging", runAt: NOW - 43200 + 1800 })]]) },
      NOW,
    );
    expect(r.map((n) => n.kind)).toContain("break-window-opened");
    expect(r.map((n) => n.kind)).toContain("break-window-closing");
  });

  it("does not warn when the window is far from closing", () => {
    const r = notifications(
      { ...replay([]), trials: new Map([[1, row({ status: "judging", runAt: NOW })]]) },
      NOW,
    );
    expect(r.map((n) => n.kind)).not.toContain("break-window-closing");
  });

  it("announces a dispute and a landed verdict", () => {
    const disputed = notifications(
      { ...replay([]), trials: new Map([[1, row({ status: "challenged", disputeOpenedAt: NOW })]]) },
      NOW,
    );
    expect(disputed.map((n) => n.kind)).toContain("dispute-opened");

    const settled = notifications(
      { ...replay([]), trials: new Map([[1, row({ status: "settled", verdict: "slashed" })]]) },
      NOW,
    );
    expect(settled[0]!.message).toContain("slashed");
  });
});

describe("notifyAll", () => {
  it("keeps going when one notifier fails", async () => {
    const send = vi.fn(async (n: { kind: string }) => {
      if (n.kind === "bad") throw new Error("webhook down");
    });
    await expect(
      notifyAll({ send }, [
        { trialId: 1, kind: "bad", message: "x" },
        { trialId: 2, kind: "good", message: "y" },
      ]),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("Warden.sweep", () => {
  const crucible = {
    address: TRIALS,
    finalize: vi.fn(async () => `0x${"ff".repeat(32)}` as `0x${string}`),
  } as unknown as Crucible;

  const wallet = {
    writeContract: vi.fn(async () => `0x${"ee".repeat(32)}` as `0x${string}`),
    account: { address: "0x5555555555555555555555555555555555555555" },
  } as unknown as WalletClient;

  it("finalizes an expired break window and reports the tx", async () => {
    const finalize = vi.fn(async () => `0x${"ff".repeat(32)}` as `0x${string}`);
    const w = new Warden({
      crucible: { ...crucible, finalize } as unknown as Crucible,
      wallet,
    });
    const model = {
      ...replay([]),
      trials: new Map([[1, row({ status: "judging", runAt: NOW - 100_000 })]]),
    };
    const out = await w.sweep(model, NOW);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(out.acted[0]!.txHash).toBeTruthy();
    expect(out.acted[0]!.error).toBeNull();
  });

  it("collects the error instead of aborting when a trial reverts", async () => {
    const finalize = vi.fn(async () => {
      throw new Error("execution reverted: NotFinalizable");
    });
    const w = new Warden({
      crucible: { ...crucible, finalize } as unknown as Crucible,
      wallet,
    });
    const model = {
      ...replay([]),
      trials: new Map([[1, row({ status: "judging", runAt: NOW - 100_000 })]]),
    };
    const out = await w.sweep(model, NOW);
    expect(out.acted[0]!.error).toContain("NotFinalizable");
    expect(out.acted[0]!.txHash).toBeNull();
  });

  it("sends notifications through the notifier when configured", async () => {
    const send = vi.fn(async () => {});
    const w = new Warden({ crucible, wallet, notifier: { send } });
    const model = {
      ...replay([]),
      trials: new Map([[1, row({ status: "judging", runAt: NOW - 100_000 })]]),
    };
    const out = await w.sweep(model, NOW);
    expect(out.notified).toBeGreaterThan(0);
    expect(send).toHaveBeenCalled();
  });
});

describe("webhookNotifier", () => {
  it("posts the message as JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const n = webhookNotifier("https://example.test/hook", fakeFetch);
    await n.send({ trialId: 1, kind: "dispute-opened", message: "hello" });
    expect(calls[0]!.url).toBe("https://example.test/hook");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "hello" });
  });

  it("throws on a non-2xx response", async () => {
    const fakeFetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    const n = webhookNotifier("https://example.test/hook", fakeFetch);
    await expect(n.send({ trialId: 1, kind: "dispute-opened", message: "x" })).rejects.toThrow(
      /500/,
    );
  });
});
