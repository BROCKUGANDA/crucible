import { describe, expect, it } from "vitest";
import {
  columnsOf,
  roleWords,
  rowsOf,
  settledNote,
  timingNote,
  type EscrowJson,
} from "../src/lib/escrow/view";

/**
 * The escrow explorer's view model (gate 838).
 *
 * The one decision here that matters more than layout: an amount nobody read must not become an
 * amount that is zero. `credit[wallet]` is the figure a visitor is standing at the page for, and
 * the host either read it or it did not — so every test below distinguishes the two, and the
 * tests that would pass with a `0` fallback are the ones that matter.
 */

function payload(over: Partial<EscrowJson> = {}): EscrowJson {
  return {
    wallet: "0x1111111111111111111111111111111111111111",
    escrowAddress: "0x4444444444444444444444444444444444444444",
    held: [
      {
        trialId: 3,
        role: "sponsor",
        kind: "reward",
        eth: "5",
        release: "back to you once the deadline passes",
        reclaimableAt: 1_700_000_000,
      },
    ],
    heldEth: "5",
    stakes: [{ agentId: 1, eth: "1" }],
    stakedEth: "1",
    withdrawableEth: "0.7",
    settledTrialIds: [1, 2],
    chainNow: 1_699_999_000,
    creditSource: { configured: true, reason: null },
    ...over,
  };
}

/** The page's layout depends on exactly three books coming back; a fourth or a missing one is a shape break. */
function books(p: EscrowJson) {
  const [locked, free, claim] = columnsOf(p);
  if (!locked || !free || !claim) throw new Error("columnsOf must return the three books");
  return { locked, free, claim };
}

describe("the three books", () => {
  it("keeps an unread claim unread instead of pricing it at zero", () => {
    const { claim } = books(payload({ withdrawableEth: null }));
    expect(claim.value).toBe("—");
    expect(claim.value).not.toBe("0 ETH");
  });

  it("prints the reason the host could not read the claim", () => {
    const { claim } = books(
      payload({
        withdrawableEth: null,
        creditSource: { configured: true, reason: "The escrow was reached but the read failed" },
      }),
    );
    expect(claim.note).toBe("The escrow was reached but the read failed");
  });

  it("says so when this host never reads per-wallet credit at all", () => {
    const { claim } = books(
      payload({
        withdrawableEth: null,
        creditSource: { configured: false, reason: "This host does not read per-wallet credit from the chain" },
      }),
    );
    expect(claim.value).toBe("—");
    expect(claim.note).toMatch(/does not read/);
  });

  it("prints a real zero when the chain says there is nothing to claim", () => {
    const { claim } = books(payload({ withdrawableEth: "0" }));
    expect(claim.value).toBe("0 ETH");
  });

  it("names the contract holding the locked ETH", () => {
    const { locked } = books(payload());
    expect(locked.value).toBe("5 ETH");
    expect(locked.note).toContain("0x4444444444444444444444444444444444444444");
  });

  it("falls back to words when the address was not read", () => {
    const { locked } = books(payload({ escrowAddress: null, heldEth: "0", held: [] }));
    expect(locked.note).toBe("nothing locked — no trial of yours is open right now");
  });

  it("distinguishes no agent from an agent with nothing staked", () => {
    const { free } = books(payload({ stakes: [], stakedEth: "0" }));
    expect(free.note).toBe("no agent registered to this address");
    const { free: held } = books(payload({ stakes: [{ agentId: 2, eth: "0" }], stakedEth: "0" }));
    expect(held.note).toMatch(/unstake/);
  });
});

describe("the rows", () => {
  it("links each lock to its trial and formats the amount", () => {
    const [row] = rowsOf(payload());
    if (!row) throw new Error("a held trial must render a row");
    expect(row.href).toBe("/trials/3");
    expect(row.amount).toBe("5 ETH");
    expect(row.who).toBe("you funded it");
    expect(row.what).toBe("reward");
  });

  it("names the part each wallet played in plain words", () => {
    expect(roleWords("sponsor")).toBe("you funded it");
    expect(roleWords("operator")).toBe("you took it on");
    expect(roleWords("skeptic")).toBe("you filed a break on it");
  });

  it("renders nothing as nothing, not as an error", () => {
    expect(rowsOf(payload({ held: [] }))).toEqual([]);
  });
});

describe("the clock", () => {
  it("says a verdict releases what no deadline does", () => {
    expect(timingNote(null, 1_700_000_000)).toBe("Released when the verdict lands, not by a timer");
  });

  it("refuses to count down without a chain clock", () => {
    expect(timingNote(1_700_000_000, null)).toContain("—");
    expect(timingNote(1_700_000_000, null)).toMatch(/no chain clock/);
  });

  it("counts down against the chain's own time", () => {
    expect(timingNote(1_700_003_600, 1_700_000_000)).toBe("deadline in 1h 0m");
  });

  it("says reclaimable now once the deadline has passed", () => {
    expect(timingNote(1_700_000_000, 1_700_000_001)).toMatch(/Past its deadline/);
  });
});

describe("settled trials", () => {
  it("says nothing settled when the list is empty", () => {
    expect(settledNote(payload({ settledTrialIds: [] }))).toBe(
      "No settled trial has involved this address yet",
    );
  });

  it("agrees with itself on one and many", () => {
    expect(settledNote(payload({ settledTrialIds: [7] }))).toMatch(/1 settled trial has/);
    expect(settledNote(payload({ settledTrialIds: [7, 8] }))).toMatch(/2 settled trials have/);
  });
});
