import { describe, expect, it, vi } from "vitest";
import { createArenaCrank, dueCrank } from "../src/arena.js";

const ARENA = "0x2222222222222222222222222222222222222222" as const;
const GRACE = 3600n;
const COMMIT = 86_400n;
const REVEAL = 86_400n;

/** [openedAt, openUntil, claimDeadline, submittedAt, windowEnd, holdoutDueBy, skepticWindow] */
function windows(over: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, bigint>> = {}) {
  return [0n, over[1] ?? 500n, over[2] ?? 500n, 0n, over[4] ?? 500n, 900n, 600] as const;
}

interface Trial {
  status: number;
  round?: number;
  w?: ReturnType<typeof windows>;
  drawnAt?: bigint;
}

function harness(trials: Trial[], opts: { revertOn?: string } = {}) {
  const sent: { functionName: string; args: readonly unknown[] }[] = [];
  const publicClient = {
    readContract: vi.fn(async (call: { functionName: string; args: readonly unknown[] }) => {
      if (call.functionName === "trialCount") return BigInt(trials.length);
      const t = trials[Number(call.args[0]) - 1]!;
      if (call.functionName === "stateOf") {
        return [t.status, 0, t.round ?? 0, false, false, false];
      }
      if (call.functionName === "windowsOf") return t.w ?? windows();
      if (call.functionName === "panelDrawnAt") return t.drawnAt ?? 0n;
      throw new Error(`unexpected read ${call.functionName}`);
    }),
  };
  const wallet = {
    writeContract: vi.fn(async (call: { functionName: string; args: readonly unknown[] }) => {
      const key = `${call.functionName}:${String(call.args[0])}`;
      if (opts.revertOn === key) throw { shortMessage: `execution reverted: ${key}` };
      sent.push({ functionName: call.functionName, args: call.args });
      return `0x${"11".repeat(32)}`;
    }),
  };
  return { publicClient: publicClient as never, wallet: wallet as never, sent };
}

describe("dueCrank", () => {
  const base = {
    round: 1,
    panelDrawnAt: 0n,
    grace: GRACE,
    commit: COMMIT,
    reveal: REVEAL,
  };

  it("expires an open trial only once its window has closed", () => {
    expect(dueCrank({ ...base, status: 0, windows: windows({ 1: 1_000n }), now: 999n })).toBeNull();
    expect(dueCrank({ ...base, status: 0, windows: windows({ 1: 1_000n }), now: 1_000n })).toEqual({
      action: "expireTrial",
    });
  });

  it("times out a claim only once its deadline has passed", () => {
    expect(dueCrank({ ...base, status: 1, windows: windows({ 2: 1_000n }), now: 999n })).toBeNull();
    expect(dueCrank({ ...base, status: 1, windows: windows({ 2: 1_000n }), now: 1_000n })).toEqual({
      action: "claimTimeout",
    });
  });

  it("freezes a docket only after the reveal grace, not at the window end", () => {
    const w = windows({ 4: 1_000n });
    expect(dueCrank({ ...base, status: 2, windows: w, now: 1_000n })).toBeNull();
    expect(dueCrank({ ...base, status: 2, windows: w, now: 1_000n + GRACE - 1n })).toBeNull();
    expect(dueCrank({ ...base, status: 2, windows: w, now: 1_000n + GRACE })).toEqual({
      action: "freezeDocket",
    });
  });

  it("draws the panel this trial owes, and only while it is undrawn", () => {
    expect(dueCrank({ ...base, status: 3, round: 2, windows: windows(), now: 1n })).toEqual({
      action: "drawPanel",
      round: 2,
    });
    expect(
      dueCrank({ ...base, status: 3, round: 2, panelDrawnAt: 7n, windows: windows(), now: 1n }),
    ).toBeNull();
  });

  it("tallies strictly after the commit and reveal windows", () => {
    const drawnAt = 1_000n;
    const end = drawnAt + COMMIT + REVEAL;
    expect(
      dueCrank({ ...base, status: 4, panelDrawnAt: drawnAt, windows: windows(), now: end }),
    ).toBeNull();
    expect(
      dueCrank({ ...base, status: 4, panelDrawnAt: drawnAt, windows: windows(), now: end + 1n }),
    ).toEqual({ action: "tally" });
  });

  it("never cranks a settled trial", () => {
    expect(
      dueCrank({ ...base, status: 5, windows: windows({ 1: 0n }), now: 10_000n, panelDrawnAt: 1n }),
    ).toBeNull();
  });
});

describe("createArenaCrank", () => {
  it("sends one crank per due trial, with the right selector and arguments", async () => {
    const { publicClient, wallet, sent } = harness([
      { status: 0, w: windows({ 1: 100n }) },
      { status: 1, w: windows({ 2: 100n }) },
      { status: 2, w: windows({ 4: 100n }) },
      { status: 3, round: 2 },
      { status: 4, round: 1, drawnAt: 1n },
      { status: 5 },
      { status: 0, w: windows({ 1: 999_999n }) },
    ]);

    const out = await createArenaCrank({ publicClient, wallet, arenaAddress: ARENA }).act(
      1_000n + GRACE + COMMIT + REVEAL,
    );

    expect(sent.map((s) => s.functionName)).toEqual([
      "expireTrial",
      "claimTimeout",
      "freezeDocket",
      "drawPanel",
      "tally",
    ]);
    expect(sent[3]!.args).toEqual([4n, 2]);
    expect(out.acted).toHaveLength(5);
    expect(out.acted.every((a) => a.txHash)).toBe(true);
  });

  it("keeps going after one trial's transaction reverts", async () => {
    const { publicClient, wallet, sent } = harness(
      [
        { status: 0, w: windows({ 1: 100n }) },
        { status: 0, w: windows({ 1: 100n }) },
        { status: 0, w: windows({ 1: 100n }) },
      ],
      { revertOn: "expireTrial:2" },
    );

    const out = await createArenaCrank({ publicClient, wallet, arenaAddress: ARENA }).act(1_000n);

    expect(sent.map((s) => s.args[0])).toEqual([1n, 3n]);
    const failed = out.acted.find((a) => a.trialId === 2);
    expect(failed?.error).toMatch(/reverted/);
    expect(failed?.txHash).toBeUndefined();
  });

  it("rotates its cursor, so a small budget visits every trial", async () => {
    const { publicClient, wallet, sent } = harness([
      { status: 0, w: windows({ 1: 100n }) },
      { status: 0, w: windows({ 1: 100n }) },
      { status: 0, w: windows({ 1: 100n }) },
    ]);
    const crank = createArenaCrank({ publicClient, wallet, arenaAddress: ARENA, maxTrialsPerTick: 1 });

    await crank.act(1_000n);
    await crank.act(1_000n);
    await crank.act(1_000n);

    expect(sent.map((s) => s.args[0])).toEqual([1n, 2n, 3n]);
  });

  it("sends nothing when the arena is empty or nothing is due", async () => {
    const empty = harness([]);
    const none = await createArenaCrank({
      publicClient: empty.publicClient,
      wallet: empty.wallet,
      arenaAddress: ARENA,
    }).act(1_000n);
    expect(none.acted).toEqual([]);

    const idle = harness([{ status: 0, w: windows({ 1: 9_999n }) }]);
    const quiet = await createArenaCrank({
      publicClient: idle.publicClient,
      wallet: idle.wallet,
      arenaAddress: ARENA,
    }).act(1_000n);
    expect(quiet.acted).toEqual([]);
    expect(idle.sent).toHaveLength(0);
  });
});
