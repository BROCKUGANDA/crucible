import { TIER_NAMES } from "@crucible/smith";
import {
  breakWindowEndsAt,
  deadlineEndsAt,
  hall,
  listTrials,
  type AgentRow,
  type HallEntry,
  type ReadModel,
  type TrialRow,
  type TrialStatus,
  type VerdictKind,
} from "./model.js";

/**
 * REST surface consumed by the frontend.
 *
 * BigInt is not JSON-serialisable, so every wei amount becomes a decimal string.
 * The UI needs exact ETH values for money; a float would be the wrong call.
 */

export interface ApiTrial {
  id: number;
  sponsor: string;
  specCID: string | null;
  testsCID: string | null;
  specDigest: string;
  testsDigest: string;
  rewardEth: string;
  bondEth: string;
  createdAt: number;
  deadline: number;
  breakWindow: number;
  agentId: number | null;
  operator: string | null;
  runHash: string | null;
  runAt: number | null;
  breakSkeptic: string | null;
  breakStakeEth: string | null;
  status: TrialStatus;
  verdict: string;
  /** absolute unix seconds, not a remaining duration: see model.ts `deadlineEndsAt` */
  deadlineAt: number | null;
  breakWindowEndsAt: number | null;
  /** true when the sponsor has not disclosed the CID text yet */
  awaitingDisclosure: boolean;
}

/**
 * What a host reports about one agent's alloy, from `AlloyRegistry`.
 *
 * Every field is nullable and `null` means "nobody read the registry for this agent" —
 * it does not mean tier 0, and it does not mean unlocked. The read model has no source
 * for any of these three facts (Scribe tails CrucibleTrials, not the registry), so a row
 * built without a host read must render as unknown rather than as a plausible number.
 */
export interface AlloyState {
  /** `records(agentId).tier` — an index into `TIER_NAMES` */
  tier: number | null;
  /** ERC-5192 `locked(agentId)`: true once the soulbound token is minted */
  locked: boolean | null;
  /** `tokenURI(agentId)`, null when unminted or unread */
  tokenUri: string | null;
}

/** The answer for a host that has no registry read — every field unknown. */
export const UNKNOWN_ALLOY: AlloyState = { tier: null, locked: null, tokenUri: null };

/**
 * The tier's name, from the tier *number the registry returned*. Kept here rather than
 * passed in by the host so the string can never drift from the number beside it, and
 * returning null for an unknown or out-of-range tier so a row cannot claim "Unforged"
 * as if it had been measured.
 */
export function tierNameFor(tier: number | null): string | null {
  if (tier === null) return null;
  return TIER_NAMES[tier] ?? null;
}

export interface ApiAgent {
  id: number;
  operator: string;
  runner: string;
  metadataURI: string;
  stakeEth: string;
  active: number;
  wins: number;
  survived: number;
  slashes: number;
  tier: number | null;
  tierName: string | null;
  alloyLocked: boolean | null;
  tokenUri: string | null;
}

export function weiToEth(wei: bigint): string {
  const negative = wei < 0n;
  const v = negative ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function toApiTrial(row: TrialRow, model: ReadModel): ApiTrial {
  const agent = row.agentId !== null ? model.agents.get(row.agentId) : undefined;
  return {
    id: row.id,
    sponsor: row.sponsor,
    specCID: row.specCID,
    testsCID: row.testsCID,
    specDigest: row.specDigest,
    testsDigest: row.testsDigest,
    rewardEth: weiToEth(row.rewardWei),
    bondEth: weiToEth(row.bondWei),
    createdAt: row.createdAt,
    deadline: row.deadline,
    breakWindow: row.breakWindow,
    agentId: row.agentId,
    operator: agent?.operator ?? null,
    runHash: row.runHash,
    runAt: row.runAt,
    breakSkeptic: row.breakSkeptic,
    breakStakeEth: row.breakStakeWei === null ? null : weiToEth(row.breakStakeWei),
    status: row.status,
    verdict: row.verdict,
    deadlineAt: deadlineEndsAt(row),
    breakWindowEndsAt: breakWindowEndsAt(row),
    awaitingDisclosure: row.specCID === null || row.testsCID === null,
  };
}

export function toApiAgent(row: AgentRow, alloy: AlloyState): ApiAgent {
  return {
    id: row.id,
    operator: row.operator,
    runner: row.runner,
    metadataURI: row.metadataURI,
    stakeEth: weiToEth(row.stakeWei),
    active: row.active,
    wins: row.wins,
    survived: row.survived,
    slashes: row.slashes,
    // Registry facts, projection facts: `wins`/`survived`/`slashes` here are this
    // process's count of `VerdictFinalized` logs, while `tier` is the registry's own
    // record — which decays wins by 25% per slash (`recordSlash`). They are allowed to
    // disagree, and one is not a correction of the other: a slashed agent can legitimately
    // show more settled-paid trials than its tier implies.
    tier: alloy.tier,
    tierName: tierNameFor(alloy.tier),
    alloyLocked: alloy.locked,
    tokenUri: alloy.tokenUri,
  };
}

/** The ERC-8004 link, as a reader can check it: id plus the log that recorded it. */
export interface ApiHallIdentity {
  /** ERC-8004 identity tokenId, decimal string — a bigint is not JSON */
  identityAgentId: string;
  txHash: string;
  blockNumber: number;
  /**
   * The contract whose log emitted `IdentityLinked`, which is CrucibleTrials. This is
   * deliberately *not* called `registry`: the event carries no registry address, and
   * the indexer never tails `IdentityRegistrySet`, so this API has no registry to name.
   */
  emitter: string;
}

/** One settled trial with the log that settled and paid it out. */
export interface ApiHallSettlement {
  trialId: number;
  verdict: VerdictKind;
  txHash: string;
  blockNumber: number;
  /** `agentPayout` in ETH, exact decimal string, same rule as every other amount here */
  payoutEth: string;
  breakFiled: boolean;
}

export interface ApiHallEntry
  extends Omit<HallEntry, "identityAgentId" | "identity" | "settlements"> {
  /** the registry's tier for this agent, null when no registry read backed it */
  tier: number | null;
  tierName: string | null;
  identityAgentId: string | null;
  identity: ApiHallIdentity | null;
  settlements: ApiHallSettlement[];
}

/**
 * There is intentionally no `alloyLocked` on a hall row. It used to be hardcoded
 * `true`, which asserted an on-chain state this function never read — a fake proof in
 * the one payload meant to be proof. Alloy lock state is a registry read, so it lives
 * on `ApiAgent.alloyLocked`, populated from the caller-supplied `alloyState`.
 *
 * `tier` is the same story one field further along: it arrived as the projection's
 * frozen `Unforged` and printed on a leaderboard next to a paid settlement. It is now
 * supplied by the caller from `AlloyRegistry`, and `null` — rendered as unknown, never
 * as a number nobody read — when the caller has no registry read to give.
 */
export function toApiHallEntry(e: HallEntry, tier: number | null = null): ApiHallEntry {
  return {
    ...e,
    tier,
    tierName: tierNameFor(tier),
    identityAgentId: e.identityAgentId === null ? null : e.identityAgentId.toString(),
    identity: e.identity
      ? {
          identityAgentId: e.identity.identityAgentId.toString(),
          txHash: e.identity.txHash,
          blockNumber: e.identity.blockNumber,
          emitter: e.identity.emitter,
        }
      : null,
    // Built field by field rather than spread-and-overwrite, because `payoutWei` is a
    // bigint and a stray copy of it would take JSON.stringify down with it.
    settlements: e.settlements.map((s) => ({
      trialId: s.trialId,
      verdict: s.verdict,
      txHash: s.txHash,
      blockNumber: s.blockNumber,
      payoutEth: weiToEth(s.payoutWei),
      breakFiled: s.breakFiled,
    })),
  };
}

export interface ApiSnapshot {
  now: number;
  trials: ApiTrial[];
  agents: ApiAgent[];
  hall: ApiHallEntry[];
  counts: Record<TrialStatus | "all", number>;
}

export function buildSnapshot(
  model: ReadModel,
  opts: {
    now: number;
    alloyState?: (agentId: number) => AlloyState;
  },
): ApiSnapshot {
  const trials = listTrials(model).map((t) => toApiTrial(t, model));

  const counts: ApiSnapshot["counts"] = {
    all: trials.length,
    open: 0,
    assigned: 0,
    judging: 0,
    challenged: 0,
    settled: 0,
  };
  for (const t of trials) counts[t.status] += 1;

  // One `alloyState` call per agent per snapshot, reused by the hall below. A host whose
  // read is expensive (or metered) should not pay twice for the same agentId in one
  // payload, and the hall must not report a tier that differs from `agents` beside it.
  const alloyById = new Map<number, AlloyState>();
  const agents = [...model.agents.values()].map((a) => {
    const alloy = opts.alloyState?.(a.id) ?? UNKNOWN_ALLOY;
    alloyById.set(a.id, alloy);
    return toApiAgent(a, alloy);
  });

  return {
    now: opts.now,
    trials,
    agents,
    hall: hall(model).map((e) => toApiHallEntry(e, alloyById.get(e.agentId)?.tier ?? null)),
    counts,
  };
}
