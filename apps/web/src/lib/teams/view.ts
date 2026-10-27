import { formatWei } from "../eth";

/**
 * The team ledger's view model (gate 879).
 *
 * `GET /teams` answers with one of three things and they must not look alike on the page: a host
 * with no TeamLedger address (`projected:false` plus the reason), a host that indexes one with no
 * teams yet, and a host with teams in it. The first is a statement about the deployment; rendering
 * an empty list for it would read as "nobody has formed a team", which is not what the host said.
 *
 * Shapes are taken from the route itself (`apps/api/src/app.ts`, the `/teams` handler): amounts are
 * wei decimal STRINGS there, not ETH strings, so `formatWei` on the digits is the only honest way
 * across. `@crucible/indexer`'s `toApiTeamLedger` serializes the same model with `weiToEth` and is
 * not what this route serves — two serializers for one read model is a drift waiting to be
 * discovered, so this file names which one it follows rather than reconciling them silently.
 */

export interface TeamStage {
  stageHash: string;
  member: string;
  seq: number;
  blockNumber: number;
}

export interface TeamFunding {
  amount: string;
  heldAfter: string;
  blockNumber: number;
}

export interface TeamShares {
  amount: string;
  remainderToLead: string;
  blockNumber: number;
}

export interface TeamRow {
  teamKey: string;
  lead: string;
  memberCount: number;
  stageCount: number;
  distributed: boolean;
  /** wei, decimal string */
  held: string;
  stages: TeamStage[];
  fundings: TeamFunding[];
  distribution: TeamShares | null;
}

export interface TeamsPayload {
  data: { teams: TeamRow[]; totalCredit?: string; heldTotal?: string };
  meta: { readModel: string; projected: boolean; count?: number; version?: number; reason?: string };
}

export interface TeamsView {
  state: "unprojected" | "empty" | "ready";
  reason: string | null;
  rows: TeamRow[];
  totalCreditEth: string;
  heldTotalEth: string;
}

const WEI = /^\d+$/;

/** A wei string, or `—` when it was not supplied. Never a zero standing in for an absence. */
export function weiToDisplay(value: string | null | undefined): string {
  if (typeof value !== "string" || !WEI.test(value)) return "—";
  return `${formatWei(BigInt(value), 6)} ETH`;
}

export function teamsView(payload: TeamsPayload): TeamsView {
  if (!payload.meta.projected) {
    return {
      state: "unprojected",
      reason: payload.meta.reason ?? "this host has no TeamLedger address",
      rows: [],
      totalCreditEth: "—",
      heldTotalEth: "—",
    };
  }

  const rows = payload.data.teams;
  return {
    state: rows.length === 0 ? "empty" : "ready",
    reason: null,
    rows,
    totalCreditEth: weiToDisplay(payload.data.totalCredit),
    heldTotalEth: weiToDisplay(payload.data.heldTotal),
  };
}

/** Stages in the order the contract numbered them — `seq` is per team and assigned on chain. */
export function stageRowsOf(team: TeamRow): { label: string; member: string; hash: string; block: number }[] {
  return [...team.stages]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ label: `stage ${s.seq}`, member: s.member, hash: s.stageHash, block: s.blockNumber }));
}

/**
 * What this team's money is doing, in the order a holder asks.
 *
 * A distributed team reads `0` held and a credit behind it: the contract converted the hold into
 * per-member pull credits, and only the member's own `withdraw()` moves ETH. Saying "paid out" here
 * would claim knowledge this read model does not have — it can see the credit, not the wallet.
 */
export function moneyLinesOf(team: TeamRow): { label: string; value: string }[] {
  const funded = team.fundings.reduce((sum, f) => (WEI.test(f.amount) ? sum + BigInt(f.amount) : sum), 0n);
  return [
    { label: "Held for this team", value: weiToDisplay(team.held) },
    { label: "Funded", value: team.fundings.length === 0 ? "—" : `${formatWei(funded, 6)} ETH` },
    {
      label: team.distributed ? "Distributed" : "Distribution",
      value: team.distribution ? weiToDisplay(team.distribution.amount) : "not yet — still held",
    },
    {
      label: "Remainder to the lead",
      value: team.distribution ? weiToDisplay(team.distribution.remainderToLead) : "—",
    },
  ];
}
