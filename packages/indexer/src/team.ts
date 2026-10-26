import type { EventLike } from "./model.js";

/**
 * The TeamLedger's read model, projected from `TeamLedger.sol`'s logs.
 *
 * This is a second model, not a second transport: `scribe.ts` now takes its contract as a
 * `LogSource`, so the same sharded, bloom-checked, quiet-tail-proof reader serves both escrows and
 * the only thing that differs is the reducer.
 *
 * The TeamLedger deliberately holds its own ETH and its own conservation equation
 * (`address(this).balance == heldTotal + totalCredit`), so nothing here touches the trials model
 * and no path here can move escrow.
 */

/** Only the events this model understands are listed. Anything else is never fetched. */
export const TEAM_LEDGER_EVENT_NAMES = [
  "TeamCreated",
  "StageAttested",
  "TeamFunded",
  "SharesDistributed",
  "Withdrawn",
] as const;

export interface StageAttestation {
  stageHash: string;
  member: string;
  seq: number;
  blockNumber: number;
}

export interface TeamFunding {
  amount: bigint;
  heldAfter: bigint;
  blockNumber: number;
}

export interface SharesDistribution {
  amount: bigint;
  remainderToLead: bigint;
  blockNumber: number;
}

export interface MemberWithdrawal {
  member: string;
  amount: bigint;
  blockNumber: number;
}

export interface TeamRow {
  teamKey: string;
  lead: string;
  memberCount: number;
  stageCount: number;
  distributed: boolean;
  held: bigint;
  stages: StageAttestation[];
  fundings: TeamFunding[];
  distribution: SharesDistribution | null;
}

export interface TeamLedgerModel {
  teams: Map<string, TeamRow>;
  /** Withdrawals keyed by member address (lowercase). */
  withdrawals: Map<string, MemberWithdrawal[]>;
  /** Running total of ETH credited to members (sum of distributed amounts). */
  totalCredit: bigint;
  /** Running total of ETH held but not yet distributed. */
  heldTotal: bigint;
  version: number;
}

export function emptyTeamLedgerModel(): TeamLedgerModel {
  return {
    teams: new Map(),
    withdrawals: new Map(),
    totalCredit: 0n,
    heldTotal: 0n,
    version: 0,
  };
}

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.length > 0) return Number(v);
  return 0;
}

function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.length > 0) return BigInt(v);
  return 0n;
}

function addr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toLowerCase() : null;
}

function bytes32(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Apply one log. Returns a NEW model and whether it changed, so the caller can decide whether to
 * bump a version or re-publish a snapshot.
 */
export function applyTeamLedgerEvent(
  model: TeamLedgerModel,
  ev: EventLike,
): { model: TeamLedgerModel; changed: boolean } {
  const teams = new Map(model.teams);
  const withdrawals = new Map(model.withdrawals);
  let totalCredit = model.totalCredit;
  let heldTotal = model.heldTotal;

  let changed = false;
  const teamKey = bytes32(ev.args.teamKey);

  switch (ev.eventName) {
    case "TeamCreated": {
      if (!teams.has(teamKey)) {
        teams.set(teamKey, {
          teamKey,
          lead: addr(ev.args.lead) ?? "",
          memberCount: num(ev.args.memberCount),
          stageCount: 0,
          distributed: false,
          held: 0n,
          stages: [],
          fundings: [],
          distribution: null,
        });
        changed = true;
      }
      break;
    }

    case "StageAttested": {
      const team = teams.get(teamKey);
      if (team) {
        const stage: StageAttestation = {
          stageHash: bytes32(ev.args.stageHash),
          member: addr(ev.args.member) ?? "",
          seq: num(ev.args.seq),
          blockNumber: Number(ev.blockNumber),
        };
        // A stage hash is attested once — ignore duplicates.
        const exists = team.stages.some((s) => s.stageHash === stage.stageHash);
        if (!exists) {
          team.stages.push(stage);
          team.stageCount = stage.seq;
          changed = true;
        }
      }
      break;
    }

    case "TeamFunded": {
      const team = teams.get(teamKey);
      if (team) {
        const amount = big(ev.args.amount);
        const heldAfter = big(ev.args.heldAfter);
        team.fundings.push({ amount, heldAfter, blockNumber: Number(ev.blockNumber) });
        team.held = heldAfter;
        heldTotal += amount;
        changed = true;
      }
      break;
    }

    case "SharesDistributed": {
      const team = teams.get(teamKey);
      if (team && !team.distributed && team.distribution === null) {
        const amount = big(ev.args.amount);
        const remainderToLead = big(ev.args.remainderToLead);
        team.distributed = true;
        team.held = 0n;
        team.distribution = { amount, remainderToLead, blockNumber: Number(ev.blockNumber) };
        totalCredit += amount;
        heldTotal -= amount;
        changed = true;
      }
      break;
    }

    case "Withdrawn": {
      // `Withdrawn` is indexed by member, not teamKey — a member can withdraw from any team
      // they hold credit in, so record it globally by member.
      const member = addr(ev.args.member);
      const amount = big(ev.args.amount);
      if (member) {
        const list = withdrawals.get(member) ?? [];
        list.push({ member, amount, blockNumber: Number(ev.blockNumber) });
        withdrawals.set(member, list);
        totalCredit -= amount;
        changed = true;
      }
      break;
    }

    default:
      break;
  }

  return {
    model: changed
      ? { teams, withdrawals, totalCredit, heldTotal, version: model.version + 1 }
      : model,
    changed,
  };
}

/** Replay a batch. Same contract as `model.replay`, so the two paths behave alike in a reorg. */
export function replayTeamLedger(
  events: readonly EventLike[],
  into: TeamLedgerModel = emptyTeamLedgerModel(),
): TeamLedgerModel {
  let model = into;
  for (const ev of events) model = applyTeamLedgerEvent(model, ev).model;
  return model;
}
