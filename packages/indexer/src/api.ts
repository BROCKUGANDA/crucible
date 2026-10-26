import { TIER_NAMES } from "@crucible/smith";
import {
  attachCids,
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
import {
  type MemberWithdrawal,
  type SharesDistribution,
  type StageAttestation,
  type TeamFunding,
  type TeamLedgerModel,
  type TeamRow,
} from "./team.js";

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
  /**
   * ADR-0012 — `epochOf(agentId)`. `epoch` counts identity handovers (1 = never handed over),
   * `epochStartedAt` is the chain's own timestamp for the transition, and the lifetime pair is the
   * book a handover cannot erase. All null when the registry was not read, which is not the same
   * answer as epoch 0.
   */
  epoch: number | null;
  epochStartedAt: number | null;
  lifetimeWins: number | null;
  lifetimeSlashes: number | null;
  /** `holderOf(agentId)` — who the current window belongs to. Never `ownerOf`, which does not move. */
  holder: string | null;
}

/** The answer for a host that has no registry read — every field unknown. */
export const UNKNOWN_ALLOY: AlloyState = {
  tier: null,
  locked: null,
  tokenUri: null,
  epoch: null,
  epochStartedAt: null,
  lifetimeWins: null,
  lifetimeSlashes: null,
  holder: null,
};

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
  /** ADR-0012: the identity epoch the figures beside these belong to. */
  epoch: number | null;
  epochStartedAt: number | null;
  lifetimeWins: number | null;
  lifetimeSlashes: number | null;
  holder: string | null;
}

/** Wei in one ETH. */
export const WEI_PER_ETH = 10n ** 18n;

/** The most decimal places a wei amount can carry, so ETH has an exact decimal form. */
export const MAX_DECIMALS = 18;

/**
 * The one wei -> ETH formatter in this repository.
 *
 * There were three: this function, `formatWei` in `apps/web/src/lib/eth.ts`, and viem's
 * `formatEther` called straight from `hall.ts`. Three implementations of one amount is not
 * three displays, it is three chances for the same wei to print as two different numbers —
 * and a reader who catches the site disagreeing with itself about a stake has no way to know
 * which of the two to distrust.
 *
 * It lives here rather than in the web app because every consumer must reach it: the read
 * model's own payloads, the hall snapshot, and the browser. A package cannot import from an
 * app, so this is the only shared position on the graph.
 *
 * Exact throughout — BigInt on the decimal string, never a float. `0.1 * 1e18` is
 * 100000000000000008, and on a contract where the stake *is* the economic commitment an
 * eight-wei lie is not a rounding note, it is a different transaction.
 *
 * `maxDecimals` truncates the fraction rather than rounding it, and trailing zeros are
 * dropped: `1.5000` is not a more precise answer than `1.5`, and a display that rounds up
 * would print a stake as larger than the operator signed for.
 */
export function weiToEth(wei: bigint, maxDecimals = MAX_DECIMALS): string {
  const negative = wei < 0n;
  const v = negative ? -wei : wei;
  const places = Math.max(0, Math.min(Math.trunc(maxDecimals), MAX_DECIMALS));
  const whole = v / WEI_PER_ETH;
  const frac = (v % WEI_PER_ETH).toString().padStart(MAX_DECIMALS, "0").slice(0, places).replace(/0+$/, "");
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
    // ADR-0012. Published beside the projection's own counts on purpose: `wins` above is this
    // process's tally of settled logs across every epoch, while the registry's window may have
    // turned over. A reader who is not told which epoch the row is in cannot tell a short record
    // from a washed one.
    epoch: alloy.epoch,
    epochStartedAt: alloy.epochStartedAt,
    lifetimeWins: alloy.lifetimeWins,
    lifetimeSlashes: alloy.lifetimeSlashes,
    holder: alloy.holder,
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
  /**
   * Chain seconds at the highest block the index has read, or `null` when nothing has been read
   * yet. `now` is the API host's wall clock; every deadline this payload carries
   * (`deadlineAt`, `breakWindowEndsAt`) is a claim about `block.timestamp`, and on a demo chain
   * that is warped on purpose the two clocks are not the same clock. A client anchors on
   * `max(headTimestamp + 1, now)` — the rule the node uses to stamp its next block.
   */
  headTimestamp: number | null;
  trials: ApiTrial[];
  agents: ApiAgent[];
  hall: ApiHallEntry[];
  counts: Record<TrialStatus | "all", number>;
  economics: ApiEconomics;
}

/**
 * The protocol's books.
 *
 * The contract keeps a settlement fee for the treasury — `FEE_BPS` of every
 * reward a trial settles in an agent's favour. Nothing published it: the fee
 * was a number in a constant and a credit in a mapping, so the product could
 * not say what it earned. A platform whose revenue is invisible is a platform
 * nobody can price, and a fee the reader has to take on faith is not much
 * better than no fee at all.
 *
 * So the books are derived here, from the same events the leaderboard is
 * built from — a settlement the hall counts is a settlement the books count,
 * because both read the same `VerdictFinalized` log.
 */
export interface ApiEconomics {
  /** settlements that paid an agent, in ETH */
  paidOutEth: string;
  /** the protocol's fee on those settlements, in ETH */
  feesEth: string;
  /** the total reward escrowed by sponsors, in ETH */
  volumeEth: string;
  /** how many trials settled in an agent's favour */
  paidSettlements: number;
  /**
   * The fee in basis points, as the chain's own constant has it — or null when the
   * constant could not be read.
   *
   * Null is the honest answer and 0 is not: the rate is a SECOND read of the chain,
   * and the money above does not depend on it. Publishing 0 for a fee that was never
   * read says the protocol charges nothing, which is a claim about the chain made by
   * a process that does not know.
   */
  feeBps: number | null;
  /**
   * What the treasury can withdraw right now: `credit[treasury]`, read off the chain.
   *
   * This is NOT `feesEth`. The fee is one income stream; the other is the treasury's 70%
   * share of every slashed skeptic bond, which the fee arithmetic never sees. The landing
   * page published the fee under a heading a reader took for the total — 0.15 ETH beside a
   * chain holding 0.305 — so both numbers were right and the page could not be reconciled.
   * Reported as null when unread: a treasury credit this process did not read is unknown,
   * and printing the fee in its place would rebuild the same false equation.
   */
  treasuryCreditEth: string | null;
}

/**
 * The protocol's books, from the read model.
 *
 * The money comes from the settlement logs, not from a re-derivation of them. The
 * contract emits `VerdictFinalized(id, Paid, reward - fee)`, so the payout it charged
 * is in the log and the fee is the difference between the escrowed reward and that
 * payout. Recomputing either from `FEE_BPS` needed a second read of the chain, and
 * when that read failed the books published a fee of zero and a payout of the FULL
 * reward — a number the chain never charged, published as though it had been
 * measured.
 *
 * `feeBps` is the one number here that still needs the constant, so it is reported
 * as read or reported as unknown.
 */
export function buildEconomics(
  model: ReadModel,
  feeBps: number | null,
  treasuryCreditWei: bigint | null = null,
): ApiEconomics {
  let paidOutWei = 0n;
  let feesWei = 0n;
  let volumeWei = 0n;
  let paidSettlements = 0;

  for (const trial of model.trials.values()) {
    volumeWei += trial.rewardWei;
    if (trial.verdict !== "paid") continue;
    paidSettlements += 1;
    // The chain's own arithmetic, from the log that settled the trial. A settlement
    // whose payout the index never saw is counted but adds nothing to either total:
    // an unknown number is not zero.
    if (trial.payoutWei === null) continue;
    paidOutWei += trial.payoutWei;
    // The fee is what the chain kept: the escrowed reward minus what it paid out.
    const fee = trial.rewardWei - trial.payoutWei;
    feesWei += fee > 0n ? fee : 0n;
  }

  return {
    paidOutEth: weiToEth(paidOutWei),
    feesEth: weiToEth(feesWei),
    volumeEth: weiToEth(volumeWei),
    paidSettlements,
    feeBps,
    treasuryCreditEth: treasuryCreditWei === null ? null : weiToEth(treasuryCreditWei),
  };
}

/**
 * The SSE frame gate, in one place.
 *
 * A subscriber compares this against its last write and only takes a new frame when it moved, so
 * the signature has to name everything the payload can change. It used to be the trial counts and
 * the length: a registry tier that moved, or a settlement fee that changed, did not move it, so no
 * frame was sent and the live view showed a stale tier indefinitely while a refresh showed the new
 * one. A replica disagreeing about *this* string is a subscriber getting a duplicate frame or
 * missing one, which is why `replica.ts` compares it alongside the read model.
 *
 * `apps/api` currently inlines the same list; adopting this function is a one-line change there,
 * in a workspace this package does not own. Until then the field list below is the one the gate is
 * asserted against (`test/convergence.test.ts`), and a drift between the two is the API's to catch.
 */
export function snapshotSignature(snap: ApiSnapshot): string {
  return [
    snap.counts.open,
    snap.counts.assigned,
    snap.counts.judging,
    snap.counts.challenged,
    snap.counts.settled,
    snap.trials.length,
    snap.economics.feesEth,
    snap.economics.paidOutEth,
    snap.agents.map((a) => `${a.id}:${a.tier ?? "?"}`).join(","),
  ].join(":");
}

export function buildSnapshot(
  model: ReadModel,
  opts: {
    now: number;
    alloyState?: (agentId: number) => AlloyState;
    /**
     * The chain's settlement fee, in basis points. Read from the contract by
     * the host rather than hardcoded here, so the published number is the one
     * the chain actually charges — or null when that read failed, which is a
     * different answer from zero.
     */
    feeBps?: number | null;
    /** Chain seconds at the highest block read; see `ApiSnapshot.headTimestamp`. */
    headTimestamp?: number | null;
    /**
     * Sponsor-published readable addresses for a trial's spec and suite.
     *
     * The chain holds only a digest; the CID that resolves to the files is published off-chain.
     * Without this the rows are permanently `awaitingDisclosure` and every trial says "suite not
     * disclosed yet", which reads as a scheduled reveal rather than an unfed field.
     */
    disclosure?: { trialId: number; specCID?: string; testsCID?: string }[];
    /**
     * `credit[treasury]` in wei, read by the host. Null means the read has not landed — the
     * books then report the treasury credit as unknown rather than as the fee, which is a
     * different number (the treasury also keeps a share of slashed bonds).
     */
    treasuryCreditWei?: bigint | null;
  },
): ApiSnapshot {
  if (opts.disclosure && opts.disclosure.length > 0) attachCids(model, opts.disclosure);

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
    headTimestamp: opts.headTimestamp ?? null,
    trials,
    agents,
    hall: hall(model).map((e) => toApiHallEntry(e, alloyById.get(e.agentId)?.tier ?? null)),
    counts,
    economics: buildEconomics(model, opts.feeBps ?? null, opts.treasuryCreditWei ?? null),
  };
}

/** The TeamLedger's public read-surface, serialized for the frontend. */

export interface ApiStageAttestation {
  stageHash: string;
  member: string;
  seq: number;
  blockNumber: number;
}

export interface ApiTeamFunding {
  amount: string; // ETH, exact decimal string
  heldAfter: string; // ETH, exact decimal string
  blockNumber: number;
}

export interface ApiSharesDistribution {
  amount: string; // ETH, exact decimal string
  remainderToLead: string; // ETH, exact decimal string
  blockNumber: number;
}

export interface ApiMemberWithdrawal {
  member: string;
  amount: string; // ETH, exact decimal string
  blockNumber: number;
}

export interface ApiTeam {
  teamKey: string;
  lead: string;
  memberCount: number;
  stageCount: number;
  distributed: boolean;
  held: string; // ETH, exact decimal string
  stages: ApiStageAttestation[];
  fundings: ApiTeamFunding[];
  distribution: ApiSharesDistribution | null;
}

export interface ApiTeamLedger {
  teams: ApiTeam[];
  /** Total ETH credited across all members (sum of distributed amounts). */
  totalCredit: string; // ETH, exact decimal string
  /** Total ETH held but not yet distributed. */
  heldTotal: string; // ETH, exact decimal string
  version: number;
}

/** The ledger's conservation equation, exposed so a reader can verify it. */
export interface ApiTeamLedgerConservation {
  balance: string; // ETH, exact decimal string — read from the contract by the host
  heldTotal: string; // ETH, exact decimal string — from the projection
  totalCredit: string; // ETH, exact decimal string — from the projection
  holds: boolean; // balance === heldTotal + totalCredit
}

function toApiStageAttestation(s: StageAttestation): ApiStageAttestation {
  return {
    stageHash: s.stageHash,
    member: s.member,
    seq: s.seq,
    blockNumber: s.blockNumber,
  };
}

function toApiTeamFunding(f: TeamFunding): ApiTeamFunding {
  return {
    amount: weiToEth(f.amount),
    heldAfter: weiToEth(f.heldAfter),
    blockNumber: f.blockNumber,
  };
}

function toApiSharesDistribution(d: SharesDistribution): ApiSharesDistribution {
  return {
    amount: weiToEth(d.amount),
    remainderToLead: weiToEth(d.remainderToLead),
    blockNumber: d.blockNumber,
  };
}

function toApiMemberWithdrawal(w: MemberWithdrawal): ApiMemberWithdrawal {
  return {
    member: w.member,
    amount: weiToEth(w.amount),
    blockNumber: w.blockNumber,
  };
}

function toApiTeam(t: TeamRow): ApiTeam {
  return {
    teamKey: t.teamKey,
    lead: t.lead,
    memberCount: t.memberCount,
    stageCount: t.stageCount,
    distributed: t.distributed,
    held: weiToEth(t.held),
    stages: t.stages.map(toApiStageAttestation),
    fundings: t.fundings.map(toApiTeamFunding),
    distribution: t.distribution ? toApiSharesDistribution(t.distribution) : null,
  };
}

/** Serialize a TeamLedgerModel for the frontend. Wei amounts cross as decimal strings. */
export function toApiTeamLedger(model: TeamLedgerModel): ApiTeamLedger {
  return {
    teams: [...model.teams.values()].map(toApiTeam).sort((a, b) => a.teamKey < b.teamKey ? -1 : 1),
    totalCredit: weiToEth(model.totalCredit),
    heldTotal: weiToEth(model.heldTotal),
    version: model.version,
  };
}

/** Serialize the conservation equation. `balance` is read from the contract by the host. */
export function toApiTeamLedgerConservation(
  balanceWei: bigint,
  model: TeamLedgerModel,
): ApiTeamLedgerConservation {
  const heldTotal = weiToEth(model.heldTotal);
  const totalCredit = weiToEth(model.totalCredit);
  const balance = weiToEth(balanceWei);
  return {
    balance,
    heldTotal,
    totalCredit,
    holds: balanceWei === model.heldTotal + model.totalCredit,
  };
}

// ── Escrow explorer (gate 838) ─────────────────────────────────────────────

export type EscrowRole = "sponsor" | "operator" | "skeptic";

/** One lock this wallet owns inside the escrow contract, and what releases it. */
export interface EscrowHolding {
  trialId: number;
  role: EscrowRole;
  /** which book of the trial this is: `reward`, `bond` or `break stake` */
  kind: "reward" | "bond" | "break stake";
  eth: string;
  /** plain words, derived from this trial's own state — never a guess about the verdict */
  release: string;
  /** unix seconds at which a permissionless call releases it, or null when a verdict does */
  reclaimableAt: number | null;
}

/** Free collateral on one of this wallet's agents: in the contract, but not locked to a trial. */
export interface EscrowStake {
  agentId: number;
  eth: string;
}

export interface ApiEscrow {
  wallet: string;
  /**
   * The contract holding every amount below. Null when the host does not know its own
   * address: a reader checking "where is my ETH" against the wrong contract is worse than
   * one who is told the address was not read.
   */
  escrowAddress: string | null;
  held: EscrowHolding[];
  heldEth: string;
  stakes: EscrowStake[];
  stakedEth: string;
  /**
   * `credit[wallet]` — what a `withdraw()` pays out today. Supplied by the caller from a
   * chain read; null means unread, and a page must print `—` rather than 0.
   */
  withdrawableEth: string | null;
  /** settled trials this wallet touched, so a claim can be traced to the row that made it */
  settledTrialIds: number[];
}

/**
 * What one wallet has inside the escrow, split by the three books the contract keeps.
 *
 * The question this answers is the one the landing page cannot: not "how much has the
 * protocol moved" but "where is MY eth, and what do I have to do to get it". The contract
 * holds the same ETH in three different states — locked to a live trial, free collateral on
 * an agent, or a settled claim waiting on `withdraw()` — and only the third is one call away.
 * Conflating them is how a reader concludes the chain lost their money.
 *
 * Nothing here re-derives a verdict. Amounts come from the rows the logs wrote, and the
 * release text names the transition that moves them, so a reader can verify it against
 * `CrucibleTrials.sol` rather than trusting this projection's arithmetic.
 */
export function buildEscrowView(
  model: ReadModel,
  wallet: string,
  opts: { escrowAddress?: string | null; withdrawableWei?: bigint | null } = {},
): ApiEscrow {
  const target = wallet.toLowerCase();

  // One wallet may operate several agents across a chain's life; `agentIdOf` is 1-based and
  // never reuses an id, so the operator is the only join available to a read model.
  const myAgentIds = new Set<number>();
  const stakes: EscrowStake[] = [];
  let stakedWei = 0n;
  for (const agent of model.agents.values()) {
    if (agent.operator.toLowerCase() !== target) continue;
    myAgentIds.add(agent.id);
    stakes.push({ agentId: agent.id, eth: weiToEth(agent.stakeWei) });
    stakedWei += agent.stakeWei;
  }
  stakes.sort((a, b) => a.agentId - b.agentId);

  const held: EscrowHolding[] = [];
  const settledTrialIds: number[] = [];
  let heldWei = 0n;

  for (const row of listTrials(model)) {
    const isSponsor = row.sponsor.toLowerCase() === target;
    const isOperator = row.agentId !== null && myAgentIds.has(row.agentId);
    const isSkeptic = row.breakSkeptic !== null && row.breakSkeptic.toLowerCase() === target;
    if (!isSponsor && !isOperator && !isSkeptic) continue;

    if (row.status === "settled") {
      settledTrialIds.push(row.id);
      // A settled trial holds nothing: the contract moved it to a claim, to free stake, or
      // to another wallet's claim. Listing it here would double-count the same ETH.
      continue;
    }

    if (isSponsor) {
      const open = row.status === "open" || row.status === "assigned";
      held.push({
        trialId: row.id,
        role: "sponsor",
        kind: "reward",
        eth: weiToEth(row.rewardWei),
        release: open
          ? "back to you once the deadline passes with no run accepted — anyone can call the reclaim"
          : "decided by the panel: paid to the agent if the work stands, refunded to you if a break is proven",
        reclaimableAt: open ? deadlineEndsAt(row) : null,
      });
      heldWei += row.rewardWei;
    }
    if (isOperator) {
      held.push({
        trialId: row.id,
        role: "operator",
        kind: "bond",
        eth: weiToEth(row.bondWei),
        release:
          "returns to your free stake when the work stands or the sponsor reclaims after the deadline; split between the skeptic and the treasury if a break is proven",
        reclaimableAt: null,
      });
      heldWei += row.bondWei;
    }
    if (isSkeptic && (row.breakStakeWei ?? 0n) > 0n) {
      held.push({
        trialId: row.id,
        role: "skeptic",
        kind: "break stake",
        eth: weiToEth(row.breakStakeWei ?? 0n),
        release:
          "returned to you with a share of the bond if your break is proven; split between the agent and the treasury if the panel rejects it",
        reclaimableAt: null,
      });
      heldWei += row.breakStakeWei ?? 0n;
    }
  }

  // Sorted by trial so the same model always renders the same table — the snapshot gate
  // compares signatures, and an order that moved would read as a change in the holdings.
  held.sort((a, b) => a.trialId - b.trialId || (a.role < b.role ? -1 : 1));

  return {
    wallet,
    escrowAddress: opts.escrowAddress ?? null,
    held,
    heldEth: weiToEth(heldWei),
    stakes,
    stakedEth: weiToEth(stakedWei),
    withdrawableEth: opts.withdrawableWei === null || opts.withdrawableWei === undefined
      ? null
      : weiToEth(opts.withdrawableWei),
    settledTrialIds: settledTrialIds.sort((a, b) => a - b),
  };
}
