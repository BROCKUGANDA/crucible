import { TIER_NAMES } from "@crucible/smith";
import {
  breakWindowEndsIn,
  deadlineEndsIn,
  hall,
  listTrials,
  type AgentRow,
  type HallEntry,
  type ReadModel,
  type TrialRow,
  type TrialStatus,
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
  coolsInSec: number | null;
  breakWindowEndsInSec: number | null;
  /** true when the sponsor has not disclosed the CID text yet */
  awaitingDisclosure: boolean;
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
  tier: number;
  tierName: string;
  alloyLocked: boolean;
  tokenUri: string | null;
}

export function weiToEth(wei: bigint): string {
  const negative = wei < 0n;
  const v = negative ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function toApiTrial(row: TrialRow, model: ReadModel, nowSeconds: number): ApiTrial {
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
    coolsInSec: deadlineEndsIn(row, nowSeconds),
    breakWindowEndsInSec: breakWindowEndsIn(row, nowSeconds),
    awaitingDisclosure: row.specCID === null || row.testsCID === null,
  };
}

export function toApiAgent(
  row: AgentRow,
  extras: { locked: boolean; tokenUri: string | null },
): ApiAgent {
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
    tier: row.tier,
    tierName: TIER_NAMES[row.tier] ?? "Unforged",
    alloyLocked: extras.locked,
    tokenUri: extras.tokenUri,
  };
}

export function toApiHallEntry(e: HallEntry): HallEntry & { alloyLocked: true } {
  return { ...e, alloyLocked: true };
}

export interface ApiSnapshot {
  now: number;
  trials: ApiTrial[];
  agents: ApiAgent[];
  hall: (HallEntry & { alloyLocked: true })[];
  counts: Record<TrialStatus | "all", number>;
}

export function buildSnapshot(
  model: ReadModel,
  opts: {
    now: number;
    alloyState?: (agentId: number) => { locked: boolean; tokenUri: string | null };
  },
): ApiSnapshot {
  const nowSeconds = Math.floor(opts.now / 1000);
  const trials = listTrials(model).map((t) => toApiTrial(t, model, nowSeconds));

  const counts: ApiSnapshot["counts"] = {
    all: trials.length,
    open: 0,
    assigned: 0,
    judging: 0,
    challenged: 0,
    settled: 0,
  };
  for (const t of trials) counts[t.status] += 1;

  const agents = [...model.agents.values()].map((a) => {
    const extras = opts.alloyState?.(a.id) ?? { locked: a.wins > 0, tokenUri: null };
    return toApiAgent(a, extras);
  });

  return {
    now: opts.now,
    trials,
    agents,
    hall: hall(model).map((e) => ({ ...e, alloyLocked: true })),
    counts,
  };
}
