import { STATUS, VERDICT, TIER, TIER_NAMES } from "@crucible/smith";

/**
 * The read model.
 *
 * Scribe holds no keys and no authority — it is a pure projection of chain events
 * plus the off-chain CID text the sponsor supplied at submission time. Anything the
 * chain cannot tell us (what the bytes32 digest *addresses*) is carried off-chain,
 * because a digest is one-way.
 */

export type TrialStatus = "open" | "assigned" | "judging" | "challenged" | "settled";
export type VerdictKind = "none" | "paid" | "slashed" | "refunded";

export interface TrialRow {
  id: number;
  sponsor: string;
  /** CID text from the sponsor's submission record. Null until the sponsor discloses. */
  specCID: string | null;
  testsCID: string | null;
  /** the on-chain commitments, always present */
  specDigest: string;
  testsDigest: string;
  rewardWei: bigint;
  bondWei: bigint;
  createdAt: number;
  deadline: number;
  breakWindow: number;
  agentId: number | null;
  runHash: string | null;
  runAt: number | null;
  breakSkeptic: string | null;
  breakStakeWei: bigint | null;
  breakProofCID: string | null;
  status: TrialStatus;
  verdict: VerdictKind;
  /** set once the indexer learns it, for the UI countdown */
  disputeOpenedAt: number | null;
}

export interface AgentRow {
  id: number;
  operator: string;
  runner: string;
  metadataURI: string;
  stakeWei: bigint;
  active: number;
  /** the on-chain bytes32 spec/tests commitments for this agent's current trial */
  wins: number;
  survived: number;
  slashes: number;
  tier: number;
}

export interface RunRow {
  trialId: number;
  agentId: number;
  runHash: string;
  signature: string | null;
  submittedAt: number;
  txHash: string | null;
  /** artifact CID, learned when the operator publishes it */
  artifactCID: string | null;
}

export interface EventLike {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  address: string;
  eventName: string;
  args: Record<string, unknown>;
}

/** Deterministic event decoding from a log, without a viem client. */
export function applyEvent(state: ReadModel, ev: EventLike): ReadModel {
  const next = cloneModel(state);
  const a = ev.args;

  switch (ev.eventName) {
    case "TrialCreated": {
      const id = num(a.id);
      next.trials.set(id, {
        id,
        sponsor: str(a.sponsor),
        specCID: null,
        testsCID: null,
        specDigest: str(a.specCID),
        testsDigest: str(a.testsCID),
        rewardWei: big(a.reward),
        bondWei: big(a.bond),
        createdAt: Number(ev.blockNumber), // replaced by block timestamp on hydrate
        deadline: num(a.deadline),
        breakWindow: num(a.breakWindow),
        agentId: null,
        runHash: null,
        runAt: null,
        breakSkeptic: null,
        breakStakeWei: null,
        breakProofCID: null,
        status: "open",
        verdict: "none",
        disputeOpenedAt: null,
      });
      next.pendingTimestamps.set(id, ev.blockNumber);
      break;
    }
    case "AgentRegistered": {
      const id = num(a.agentId);
      next.agents.set(id, {
        id,
        operator: str(a.operator),
        runner: str(a.runner),
        metadataURI: str(a.metadataURI),
        stakeWei: big(a.stake),
        active: 0,
        wins: 0,
        survived: 0,
        slashes: 0,
        tier: TIER.Unforged,
      });
      break;
    }
    case "TrialClaimed": {
      const t = next.trials.get(num(a.id));
      if (t) {
        t.agentId = num(a.agentId);
        t.status = "assigned";
      }
      break;
    }
    case "RunSubmitted": {
      const id = num(a.id);
      const t = next.trials.get(id);
      if (t) {
        t.agentId = num(a.agentId);
        t.runHash = str(a.runHash);
        t.runAt = Number(ev.blockNumber);
        t.status = "judging";
      }
      next.runs.set(id, {
        trialId: id,
        agentId: num(a.agentId),
        runHash: str(a.runHash),
        signature: null,
        submittedAt: Number(ev.blockNumber),
        txHash: ev.transactionHash,
        artifactCID: null,
      });
      break;
    }
    case "BreakFiled": {
      const t = next.trials.get(num(a.id));
      if (t) {
        t.breakSkeptic = str(a.skeptic);
        t.breakStakeWei = big(a.stake);
        t.breakProofCID = str(a.proofCID);
        t.status = "challenged";
        t.disputeOpenedAt = Number(ev.blockNumber);
      }
      break;
    }
    case "DisputeOpened": {
      const t = next.trials.get(num(a.id));
      if (t) t.disputeOpenedAt = Number(ev.blockNumber);
      break;
    }
    case "VerdictFinalized": {
      const t = next.trials.get(num(a.id));
      if (t) {
        t.status = "settled";
        t.verdict = verdictName(num(a.verdict));
      }
      break;
    }
    default:
      break;
  }
  return next;
}

export interface ReadModel {
  trials: Map<number, TrialRow>;
  agents: Map<number, AgentRow>;
  runs: Map<number, RunRow>;
  /** trialId -> block, so a hydrate pass can attach real timestamps */
  pendingTimestamps: Map<number, bigint>;
}

export function emptyModel(): ReadModel {
  return {
    trials: new Map(),
    agents: new Map(),
    runs: new Map(),
    pendingTimestamps: new Map(),
  };
}

export function replay(events: EventLike[], into: ReadModel = emptyModel()): ReadModel {
  return events.reduce(applyEvent, into);
}

/**
 * Attach real block timestamps. Event blocks carry no wall-clock time, and the
 * frontend's countdowns depend on `deadline`/`runAt` being real seconds — using a
 * block number there would produce nonsense countdowns.
 */
export function hydrateTimestamps(model: ReadModel, blockTime: Map<bigint, number>): ReadModel {
  for (const t of model.trials.values()) {
    t.createdAt = blockTime.get(BigInt(t.createdAt)) ?? t.createdAt;
    t.runAt = t.runAt === null ? null : (blockTime.get(BigInt(t.runAt)) ?? t.runAt);
    t.disputeOpenedAt =
      t.disputeOpenedAt === null ? null : (blockTime.get(BigInt(t.disputeOpenedAt)) ?? t.disputeOpenedAt);
  }
  return model;
}

/**
 * Attach the sponsor's CID text. The chain commits to digests; the text that
 * actually addresses the content only exists off-chain. Without this the UI can
 * show a hash but cannot link to IPFS, and Argus cannot re-run the suite.
 */
export function attachCids(
  model: ReadModel,
  disclosure: { trialId: number; specCID?: string; testsCID?: string }[],
): ReadModel {
  for (const d of disclosure) {
    const t = model.trials.get(d.trialId);
    if (!t) continue;
    if (d.specCID) t.specCID = d.specCID;
    if (d.testsCID) t.testsCID = d.testsCID;
  }
  return model;
}

export function attachSignatures(
  model: ReadModel,
  sigs: { trialId: number; signature: string }[],
): ReadModel {
  for (const s of sigs) {
    const r = model.runs.get(s.trialId);
    if (r) r.signature = s.signature;
  }
  return model;
}

export function listTrials(model: ReadModel, filter?: TrialStatus): TrialRow[] {
  const all = [...model.trials.values()].sort((a, b) => b.id - a.id);
  return filter ? all.filter((t) => t.status === filter) : all;
}

export interface HallEntry {
  agentId: number;
  operator: string;
  tier: number;
  tierName: string;
  wins: number;
  survived: number;
  slashes: number;
}

/** /hall — ranked by wins, then survived, then fewest slashes. */
export function hall(model: ReadModel): HallEntry[] {
  return [...model.agents.values()]
    .filter((a) => a.wins > 0)
    .map((a) => ({
      agentId: a.id,
      operator: a.operator,
      tier: a.tier,
      tierName: TIER_NAMES[a.tier] ?? "Unforged",
      wins: a.wins,
      survived: a.survived,
      slashes: a.slashes,
    }))
    .sort((x, y) => y.wins - x.wins || y.survived - x.survived || x.slashes - y.slashes);
}

/** Seconds until the break window closes; null when not applicable. */
export function breakWindowEndsIn(row: TrialRow, nowSeconds: number): number | null {
  if (row.status !== "judging" || row.runAt === null) return null;
  return Math.max(0, row.runAt + row.breakWindow - nowSeconds);
}

export function deadlineEndsIn(row: TrialRow, nowSeconds: number): number | null {
  if (row.status === "settled") return null;
  return Math.max(0, row.deadline - nowSeconds);
}

function cloneModel(m: ReadModel): ReadModel {
  return {
    trials: new Map([...m.trials].map(([k, v]) => [k, { ...v }])),
    agents: new Map([...m.agents].map(([k, v]) => [k, { ...v }])),
    runs: new Map([...m.runs].map(([k, v]) => [k, { ...v }])),
    pendingTimestamps: new Map(m.pendingTimestamps),
  };
}

function str(v: unknown): string {
  return String(v ?? "");
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  return BigInt(String(v ?? "0"));
}

function verdictName(v: number): VerdictKind {
  switch (v) {
    case VERDICT.Paid:
      return "paid";
    case VERDICT.Slashed:
      return "slashed";
    case VERDICT.Refunded:
      return "refunded";
    default:
      return "none";
  }
}

export { STATUS, VERDICT, TIER, TIER_NAMES };
