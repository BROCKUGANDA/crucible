import { STATUS, VERDICT, TIER, TIER_NAMES } from "@crucible/smith";

/**
 * The read model.
 *
 * Scribe holds no keys and no authority — it is a pure projection of chain events
 * plus the off-chain CID text the sponsor supplied at submission time. Anything the
 * chain cannot tell us (what the bytes32 digest *addresses*) is carried off-chain,
 * because a digest is one-way.
 *
 * The projection also keeps the log it read each fact from. A win count nobody can
 * re-fetch is not evidence, so `VerdictFinalized` and `IdentityLinked` provenance is
 * carried alongside the value — that is what lets /hall be checked rather than believed.
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

/**
 * One settled trial, with the log that settled it. This is the hall's evidence: a
 * reader takes `txHash`, re-fetches the receipt, and checks the payout themselves
 * instead of trusting this projection's arithmetic.
 */
export interface Settlement {
  trialId: number;
  verdict: VerdictKind;
  txHash: string;
  blockNumber: number;
  /** `agentPayout` from the event, in wei */
  payoutWei: bigint;
  /** a skeptic filed a break against this run before it settled */
  breakFiled: boolean;
}

/** Provenance of the ERC-8004 link, from the IdentityLinked log. */
export interface IdentityProof {
  identityAgentId: bigint;
  txHash: string;
  blockNumber: number;
  /**
   * The address whose log emitted the link — CrucibleTrials, *not* the ERC-8004
   * registry. `IdentityLinked(agentId, identityAgentId)` carries no registry address,
   * and the registry only appears in `IdentityRegistrySet`, which the indexer does not
   * tail. A `registry` field here would be an invention, so the field says what it is.
   */
  emitter: string;
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
  /**
   * No `tier` here, on purpose. A tier is `AlloyRegistry.records(agentId).tier`, written
   * by `recordWin`/`recordSlash` and signalled only by `TierChanged`, which is emitted by
   * the *registry* — a contract Scribe does not tail (it indexes CrucibleTrials only).
   * This row used to carry `tier: TIER.Unforged`, set once at registration and never
   * rewritten, so every hall row printed "Unforged" over an agent the chain had already
   * moved to Iron. A projection cannot publish a fact it has no source for; the API gets
   * the tier from the registry instead (see `api.ts`'s `AlloyState`).
   */
  /** ERC-8004 identity tokenId, or null if the operator has not linked it */
  identityAgentId: bigint | null;
  /** the link above, with the log proving it; null when nothing is linked */
  identity: IdentityProof | null;
  /** settled trials this agent was the runner in, newest first, capped at MAX_SETTLEMENTS */
  settlements: Settlement[];
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

/**
 * How much settlement history an agent carries. The hall shows a handful of proofs,
 * not an audit log, and an agent that has settled 500 trials must not turn every
 * snapshot into a megabyte. Oldest entries fall off the tail.
 */
export const MAX_SETTLEMENTS = 10;

/**
 * Move a trial forward, never back.
 *
 * Settlement is terminal on chain — `_settle` reverts `AlreadySettled` and no function
 * returns a trial from there — so the projection refuses it too. Without this, a re-read
 * `TrialClaimed` or `RunSubmitted` re-opens an already-settled trial and the duplicate
 * `VerdictFinalized` behind it counts the win a second time: the guards in each case would
 * only ever see the status the previous case had just reset.
 */
function advance(t: TrialRow, to: TrialStatus): void {
  if (t.status === "settled") return;
  t.status = to;
}

/** Deterministic event decoding from a log, without a viem client. */
export function applyEvent(state: ReadModel, ev: EventLike): ReadModel {
  const next = cloneModel(state);
  const a = ev.args;

  switch (ev.eventName) {
    case "TrialCreated": {
      const id = num(a.id);
      // A re-read log must not reset a trial that has already moved on. The contract hands
      // out ids from a counter, so a second TrialCreated for the same id is never a real
      // second event — it is the same log arriving twice, from an overlapping shard or a
      // reorg. Keeping the existing row is what makes ingest replay-safe.
      if (next.trials.has(id)) break;
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
      // `registerAgent` reverts `AlreadyRegistered`, so a repeat of this log is a re-read,
      // not a re-registration. Recreating the row here would zero the agent's wins, scars
      // and settlement receipts — the projection quietly forgetting what the chain knows.
      if (next.agents.has(id)) break;
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
        identityAgentId: null,
        identity: null,
        settlements: [],
      });
      break;
    }
    case "IdentityLinked": {
      const t = next.agents.get(num(a.agentId));
      if (t) {
        const identityAgentId = big(a.identityAgentId);
        // Re-linking replaces the proof rather than appending: the chain's current
        // `identityOf[agentId]` is the last link, and a hall row must not advertise a
        // tokenId the contract no longer holds.
        t.identityAgentId = identityAgentId;
        t.identity = {
          identityAgentId,
          txHash: ev.transactionHash,
          blockNumber: Number(ev.blockNumber),
          emitter: ev.address,
        };
      }
      break;
    }
    case "TrialClaimed": {
      const t = next.trials.get(num(a.id));
      if (t) {
        t.agentId = num(a.agentId);
        advance(t, "assigned");
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
        advance(t, "judging");
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
        advance(t, "challenged");
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
      // The one transition in the protocol that *adds* to a counter, so the one a duplicate
      // can inflate. A trial settles once on chain (`_settle` reverts `AlreadySettled`) and
      // the contract has no path back, so an already-settled row means this log has already
      // been applied — from an overlapping shard, or from a reorg that re-mined the block
      // under a new tx hash. Skipping keeps a replay from minting reputation the chain never
      // awarded.
      if (!t || t.status === "settled") break;
      {
        t.status = "settled";
        t.verdict = verdictName(num(a.verdict));

        // The hall exists because of this counter. A paid trial increments wins, and a
        // paid trial that had a break filed against it increments survived — that is
        // the "quoted the whole attack and held" signal. A slash increments scars.
        const agent = t.agentId !== null ? next.agents.get(t.agentId) : undefined;
        if (agent) {
          if (t.verdict === "paid") {
            agent.wins += 1;
            if (t.breakSkeptic !== null) agent.survived += 1;
          } else if (t.verdict === "slashed") {
            agent.slashes += 1;
          }

          // Every settled verdict is recorded, not just the flattering ones: a hall row
          // that can only produce receipts for wins is a hall row that cannot be checked.
          agent.settlements = [
            {
              trialId: t.id,
              verdict: t.verdict,
              txHash: ev.transactionHash,
              blockNumber: Number(ev.blockNumber),
              payoutWei: big(a.agentPayout),
              breakFiled: t.breakSkeptic !== null,
            },
            ...agent.settlements,
          ].slice(0, MAX_SETTLEMENTS);
        }
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

/**
 * One hall row as the projection can honestly make it: counters, and the logs behind
 * them. The tier is deliberately absent — see the note on `AgentRow` — and the API
 * attaches it from `AlloyRegistry` at render time (`api.ts`'s `toApiHallEntry`).
 */
export interface HallEntry {
  agentId: number;
  operator: string;
  wins: number;
  survived: number;
  slashes: number;
  /** ERC-8004 identity tokenId, or null when not linked */
  identityAgentId: bigint | null;
  /** the IdentityLinked log behind the id above; null when nothing is linked */
  identity: IdentityProof | null;
  /** the settled trials behind the counters, newest first */
  settlements: Settlement[];
}

/** /hall — ranked by wins, then survived, then fewest slashes. */
export function hall(model: ReadModel): HallEntry[] {
  return [...model.agents.values()]
    .filter((a) => a.wins > 0)
    .map((a) => ({
      agentId: a.id,
      operator: a.operator,
      wins: a.wins,
      survived: a.survived,
      slashes: a.slashes,
      identityAgentId: a.identityAgentId,
      // Copies, not the projection's own objects: a hall entry is handed to a caller
      // who may serialise or mutate it, and neither may reach back into the read model.
      identity: a.identity ? { ...a.identity } : null,
      settlements: a.settlements.map((s) => ({ ...s })),
    }))
    .sort((x, y) => y.wins - x.wins || y.survived - x.survived || x.slashes - y.slashes);
}

/** Seconds until the break window closes; null when not applicable. */
/**
 * When the break window closes, as an absolute unix second — not "seconds remaining".
 *
 * A remaining-duration is a fact about the moment the snapshot was built, so it starts
 * decaying the instant it leaves the server, and a client that renders it against its own
 * clock gets a number that is already wrong. The API sends the deadline and the client
 * subtracts the server's own `now`, which is the only clock that decides the question.
 *
 * Null when there is no window to close: `judging` is the only status with a live break
 * window, and `runAt` is null until a run lands.
 */
export function breakWindowEndsAt(row: TrialRow): number | null {
  if (row.status !== "judging" || row.runAt === null) return null;
  return row.runAt + row.breakWindow;
}

/** When the submission deadline passes, absolute, or null once the trial has settled. */
export function deadlineEndsAt(row: TrialRow): number | null {
  if (row.status === "settled") return null;
  return row.deadline;
}

function cloneModel(m: ReadModel): ReadModel {
  return {
    trials: new Map([...m.trials].map(([k, v]) => [k, { ...v }])),
    // `{ ...v }` alone is a bug waiting to happen now that AgentRow holds an object and
    // an array of objects: the spread copies the *references*, so two snapshots would
    // share one Settlement and one IdentityProof, and `applyEvent` mutates the clone it
    // returns. Copy those nested values so every snapshot owns its own evidence.
    agents: new Map(
      [...m.agents].map(([k, v]) => [
        k,
        {
          ...v,
          identity: v.identity ? { ...v.identity } : null,
          settlements: v.settlements.map((s) => ({ ...s })),
        },
      ]),
    ),
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
