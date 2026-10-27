import { describe, expect, it } from "vitest";
import {
  moneyLinesOf,
  stageRowsOf,
  teamsView,
  weiToDisplay,
  type TeamRow,
  type TeamsPayload,
} from "../src/lib/teams/view";

/**
 * The team ledger's view model (gate 879).
 *
 * Three states the page must not blur, and one number that must not be rounded: a host that is not
 * indexing a ledger, a ledger with nothing in it, and a ledger with a team. The first two look the
 * same in any implementation that forgets `meta.projected`, and the difference is a sentence a
 * visitor is told about their own money.
 */

function team(over: Partial<TeamRow> = {}): TeamRow {
  return {
    teamKey: "0x" + "11".repeat(32),
    lead: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    memberCount: 3,
    stageCount: 2,
    distributed: true,
    held: "0",
    stages: [
      {
        stageHash: "0xcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcf",
        member: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
        seq: 2,
        blockNumber: 75,
      },
      {
        stageHash: "0x7676767676767676767676767676767676767676767676767676767676767676",
        member: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
        seq: 1,
        blockNumber: 74,
      },
    ],
    fundings: [{ amount: "600000000000000000", heldAfter: "600000000000000000", blockNumber: 76 }],
    distribution: { amount: "600000000000000000", remainderToLead: "0", blockNumber: 77 },
    ...over,
  };
}

function payload(over: Partial<TeamsPayload> = {}): TeamsPayload {
  return {
    data: { teams: [team()], totalCredit: "600000000000000000", heldTotal: "0" },
    meta: { readModel: "team-ledger", projected: true, count: 1, version: 5 },
    ...over,
  };
}

describe("the three states", () => {
  it("keeps a host that is not indexing a ledger separate from a ledger with no teams", () => {
    const unprojected = teamsView({
      data: { teams: [] },
      meta: { readModel: "team-ledger", projected: false, reason: "no TeamLedger address on this host" },
    });
    expect(unprojected.state).toBe("unprojected");
    expect(unprojected.reason).toBe("no TeamLedger address on this host");
    // The totals of a host that read nothing are not zero.
    expect(unprojected.totalCreditEth).toBe("—");
    expect(unprojected.heldTotalEth).toBe("—");
  });

  it("calls an empty projected ledger empty, not unprojected", () => {
    const view = teamsView(payload({ data: { teams: [], totalCredit: "0", heldTotal: "0" } }));
    expect(view.state).toBe("empty");
    expect(view.totalCreditEth).toBe("0 ETH");
  });

  it("falls back to words when the host omits its reason", () => {
    const view = teamsView({ data: { teams: [] }, meta: { readModel: "team-ledger", projected: false } });
    expect(view.reason).toMatch(/no TeamLedger address/);
  });

  it("shows the chain's totals for a projected ledger with a team in it", () => {
    const view = teamsView(payload());
    expect(view.state).toBe("ready");
    expect(view.totalCreditEth).toBe("0.6 ETH");
    expect(view.heldTotalEth).toBe("0 ETH");
  });
});

describe("amounts", () => {
  it("formats wei decimal strings, and truncates rather than rounds", () => {
    expect(weiToDisplay("1000000000000000000")).toBe("1 ETH");
    // Six decimals is this view's display choice; truncation is not cosmetic — a figure rounded up
    // would claim the chain holds more than it does (the same rule `formatEth` states).
    expect(weiToDisplay("1234567890123456789")).toBe("1.234567 ETH");
    expect(weiToDisplay("999999999999999999")).toBe("0.999999 ETH");
  });

  it("keeps an amount that is not a number unrendered", () => {
    expect(weiToDisplay(undefined)).toBe("—");
    expect(weiToDisplay("0.6")).toBe("—");
    expect(weiToDisplay("null")).toBe("—");
  });

  it("sums a team's funding events rather than trusting the last hold", () => {
    const twice = team({
      fundings: [
        { amount: "200000000000000000", heldAfter: "200000000000000000", blockNumber: 10 },
        { amount: "400000000000000000", heldAfter: "600000000000000000", blockNumber: 12 },
      ],
    });
    const funded = moneyLinesOf(twice).find((l) => l.label === "Funded");
    expect(funded?.value).toBe("0.6 ETH");
  });

  it("says a team is undistributed instead of showing a zero distribution", () => {
    const lines = moneyLinesOf(team({ distributed: false, distribution: null, held: "600000000000000000" }));
    expect(lines.find((l) => l.label === "Distribution")?.value).toBe("not yet — still held");
    expect(lines.find((l) => l.label === "Remainder to the lead")?.value).toBe("—");
    expect(lines.find((l) => l.label === "Held for this team")?.value).toBe("0.6 ETH");
  });

  it("shows a zero hold as the measurement it is", () => {
    const lines = moneyLinesOf(team());
    expect(lines.find((l) => l.label === "Held for this team")?.value).toBe("0 ETH");
    expect(lines.find((l) => l.label === "Distributed")?.value).toBe("0.6 ETH");
    expect(lines.find((l) => l.label === "Remainder to the lead")?.value).toBe("0 ETH");
  });

  it("carries a team with no funding events as unknown, not free", () => {
    expect(moneyLinesOf(team({ fundings: [] })).find((l) => l.label === "Funded")?.value).toBe("—");
  });
});

describe("stages", () => {
  it("orders them by the number the contract assigned", () => {
    const rows = stageRowsOf(team());
    expect(rows.map((r) => r.label)).toEqual(["stage 1", "stage 2"]);
    expect(rows[0]?.member).toBe("0x15d34aaf54267db7d7c367839aaf71a00a2c6a65");
  });

  it("keeps the digest a reader would re-hash, not a truncated one in its place", () => {
    const rows = stageRowsOf(team());
    expect(rows[0]?.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("returns nothing for a team whose stages have not landed", () => {
    expect(stageRowsOf(team({ stages: [], stageCount: 0 }))).toEqual([]);
  });
});
