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
  /**
   * What the agent was actually paid, in wei — the `agentPayout` of the
   * `VerdictFinalized` log. Null until the trial settles.
   *
   * The contract emits `reward - fee`, so this is the chain's OWN arithmetic
   * rather than something recomputed here. It matters because the recomputation
   * needs `FEE_BPS`, which is a second read that can fail: when it did, the
   * published books showed a fee of zero and a payout of the FULL reward, which
   * is a number the chain never charged and nobody had verified. The settlement
   * log carries the answer already; nothing has to guess it.
   */
  payoutWei: bigint | null;
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
  /**
   * The index never saw this trial's creation.
   *
   * A verdict whose trial is unknown means the index started after the trial
   * was created — a `FROM_BLOCK` that is too high, or a cursor file from a
   * chain that was rebuilt. The old code dropped the log, so the settlement,
   * the win and the receipt all vanished with no trace: the hall simply did
   * not mention a trial that had been paid out. The row is created instead,
   * incomplete, and counted — so the loss is visible rather than silent.
   */
  incomplete?: boolean;
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
 * The status chain, in order.
 *
 * A trial moves `open → assigned → judging → challenged → settled`, and the
 * order is what makes "never back" enforceable. The old guard only refused to
 * move out of `settled`, so every other transition was free: a re-read
 * `TrialClaimed` after a `RunSubmitted` moved a judging trial back to
 * assigned, and a re-read `RunSubmitted` after a `BreakFiled` moved a
 * challenged trial back to judging — erasing the challenge while leaving
 * `breakSkeptic` and the stake set, so the row said "judging" about a trial
 * that was under dispute. The log-sorted replay path hid it; `applyEvent` is
 * public and order-agnostic, so a shard overlap or a reorg could produce it.
 */
const STATUS_ORDER: Record<TrialStatus, number> = {
  open: 0,
  assigned: 1,
  judging: 2,
  challenged: 3,
  settled: 4,
};

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
  // Forward only, and only strictly forward: a status is a place on a chain,
  // not a bag of labels.
  if (STATUS_ORDER[to] <= STATUS_ORDER[t.status]) return;
  t.status = to;
}

/** Deterministic event decoding from a log, without a viem client. */
export function applyEvent(state: ReadModel, ev: EventLike): ReadModel {
  const next = cloneModel(state);
  if (didMutate(next, ev)) next.version += 1;
  return next;
}

/**
 * `applyEvent` without the clone: it mutates `state` and returns the same object.
 *
 * The per-event clone made a backfill quadratic — `replay` copied the entire growing model
 * once per log, so 4,000 trials cost 55 seconds against 231ms for 250, which is 16x the work
 * for 238x the time. The clone buys nothing here either: the batch is applied synchronously
 * with no `await` inside it, so the event loop cannot yield mid-batch and no request can ever
 * observe a half-applied model. Atomicity came from single-threadedness, not from copying.
 *
 * Keep using the pure `applyEvent` when a caller needs its own snapshot of one step.
 */
export function applyEventInto(state: ReadModel, ev: EventLike): ReadModel {
  if (didMutate(state, ev)) state.version += 1;
  return state;
}

/** Applies `ev` to `state` in place. Returns true when the model actually changed. */
function didMutate(next: ReadModel, ev: EventLike): boolean {
  const a = ev.args;

  switch (ev.eventName) {
    case "TrialCreated": {
      const id = num(a.id);
      // A re-read log must not reset a trial that has already moved on. The contract hands
      // out ids from a counter, so a second TrialCreated for the same id is never a real
      // second event — it is the same log arriving twice, from an overlapping shard or a
      // reorg. Keeping the existing row is what makes ingest replay-safe.
      if (next.trials.has(id)) return false;
      next.trials.set(id, {
        id,
        sponsor: str(a.sponsor),
        specCID: null,
        testsCID: null,
        specDigest: str(a.specCID),
        testsDigest: str(a.testsCID),
        rewardWei: big(a.reward),
        bondWei: big(a.bond),
        payoutWei: null,
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
      return true;
    }
    case "AgentRegistered": {
      const id = num(a.agentId);
      // `registerAgent` reverts `AlreadyRegistered`, so a repeat of this log is a re-read,
      // not a re-registration. Recreating the row here would zero the agent's wins, scars
      // and settlement receipts — the projection quietly forgetting what the chain knows.
      if (next.agents.has(id)) return false;
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
      return true;
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
        return true;
      }
      return false;
    }
    case "TrialClaimed": {
      const t = next.trials.get(num(a.id));
      if (!t) return false;
      // A claim is a one-way door: a re-read must not take a second bond or count a
      // second active trial.
      if (t.status !== "open") return false;
      t.agentId = num(a.agentId);
      const agent = next.agents.get(t.agentId);
      if (agent) {
        // `Agent.stake` is FREE stake. The bond moves from it into escrow at claim.
        const bond = big(a.bond);
        agent.stakeWei = agent.stakeWei > bond ? agent.stakeWei - bond : 0n;
        agent.active += 1;
      }
      advance(t, "assigned");
      return true;
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
      return true;
    }
    case "BreakFiled": {
      const t = next.trials.get(num(a.id));
      if (!t) return false;
      t.breakSkeptic = str(a.skeptic);
      t.breakStakeWei = big(a.stake);
      t.breakProofCID = str(a.proofCID);
      advance(t, "challenged");
      t.disputeOpenedAt = Number(ev.blockNumber);
      return true;
    }
    case "DisputeOpened": {
      const t = next.trials.get(num(a.id));
      if (!t) return false;
      t.disputeOpenedAt = Number(ev.blockNumber);
      return true;
    }
    case "VerdictFinalized": {
      const t = next.trials.get(num(a.id));
      // The one transition in the protocol that *adds* to a counter, so the one a duplicate
      // can inflate. A trial settles once on chain (`_settle` reverts `AlreadySettled`) and
      // the contract has no path back, so an already-settled row means this log has already
      // been applied — from an overlapping shard, or from a reorg that re-mined the block
      // under a new tx hash. Skipping keeps a replay from minting reputation the chain never
      // awarded.
      if (t?.status === "settled") return false;
      // Captured before the row becomes terminal: a live trial frees one active slot,
      // and a paid or refunded verdict returns its bond to the agent's free stake.
      const priorStatus = t?.status ?? "open";
      const wasLive =
        priorStatus === "assigned" || priorStatus === "judging" || priorStatus === "challenged";
      // A verdict for a trial this index never saw is not dropped. It means the
      // index started after the trial was created, and the old behaviour —
      // returning false — lost the settlement, the win and the receipt with no
      // trace, so a paid trial simply did not appear on the hall. The row is
      // created, marked incomplete, and the operator is told by the count.
      const row =
        t ??
        ({
          id: num(a.id),
          sponsor: "",
          specCID: null,
          testsCID: null,
          specDigest: "0x" + "00".repeat(32),
          testsDigest: "0x" + "00".repeat(32),
          rewardWei: 0n,
          bondWei: 0n,
          payoutWei: null,
          createdAt: Number(ev.blockNumber),
          deadline: 0,
          breakWindow: 0,
          agentId: null,
          runHash: null,
          runAt: null,
          breakSkeptic: null,
          breakStakeWei: null,
          breakProofCID: null,
          status: "open",
          verdict: "none",
          disputeOpenedAt: null,
          incomplete: true,
        } satisfies TrialRow);
      if (!t) next.trials.set(row.id, row);
      {
        row.status = "settled";
        row.verdict = verdictName(num(a.verdict));
        // The chain's own payout, from the event that settled the trial. `reward - fee`
        // is what the contract computed and emitted, so this is a fact rather than a
        // re-derivation of one — see `TrialRow.payoutWei`.
        row.payoutWei = big(a.agentPayout);

        // The hall exists because of this counter. A paid trial increments wins, and a
        // paid trial that had a break filed against it increments survived — that is
        // the "quoted the whole attack and held" signal. A slash increments scars.
        const agent = row.agentId !== null ? next.agents.get(row.agentId) : undefined;
        if (agent) {
          if (wasLive) {
            agent.active = Math.max(0, agent.active - 1);
            if (row.verdict === "paid" || row.verdict === "refunded") {
              agent.stakeWei += row.bondWei; // bond freed from escrow
            }
          }
          if (row.verdict === "paid") {
            agent.wins += 1;
            if (row.breakSkeptic !== null) agent.survived += 1;
          } else if (row.verdict === "slashed") {
            agent.slashes += 1;
          }

          // Every settled verdict is recorded, not just the flattering ones: a hall row
          // that can only produce receipts for wins is a hall row that cannot be checked.
          agent.settlements = [
            {
              trialId: row.id,
              verdict: row.verdict,
              txHash: ev.transactionHash,
              blockNumber: Number(ev.blockNumber),
              payoutWei: big(a.agentPayout),
              breakFiled: row.breakSkeptic !== null,
            },
            ...agent.settlements,
          ].slice(0, MAX_SETTLEMENTS);
        }
      }
      return true;
    }
    case "StakeWithdrawn": {
      const agent = next.agents.get(num(a.agentId));
      if (!agent) return false;
      const amount = big(a.amount);
      const nextStake = agent.stakeWei - amount;
      // The contract cannot over-withdraw; a clamp here only protects the projection
      // from a replayed log, never from a real balance.
      agent.stakeWei = nextStake > 0n ? nextStake : 0n;
      return true;
    }
    case "RunnerSet": {
      const agent = next.agents.get(num(a.agentId));
      if (!agent) return false;
      agent.runner = str(a.runner);
      return true;
    }
    default:
      return false;
  }
  return true;
}

export interface ReadModel {
  trials: Map<number, TrialRow>;
  agents: Map<number, AgentRow>;
  runs: Map<number, RunRow>;
  /**
   * Bumped once per log that actually changed something. A consumer that rebuilds a
   * projection of this model — the API's per-tick snapshot — can skip the rebuild when the
   * version is unchanged, which is the difference between rebuilding a 5 MB payload once a
   * second forever and rebuilding it when the chain moved.
   *
   * Duplicate logs do not bump it. That is the whole point: the same guard that stops a
   * reorg from double-counting a win also stops a reorg from invalidating every cache.
   */
  version: number;
}

export function emptyModel(): ReadModel {
  return {
    trials: new Map(),
    agents: new Map(),
    runs: new Map(),
    version: 0,
  };
}

/**
 * Fold a batch of logs into a model. `into` is **mutated** and returned — see
 * `applyEventInto` for why this is safe and what the previous per-event clone cost. A caller
 * that needs to keep the original passes `cloneModel(original)` as `into`.
 */
export function replay(events: EventLike[], into: ReadModel = emptyModel()): ReadModel {
  for (const ev of events) {
    if (didMutate(into, ev)) into.version += 1;
  }
  return into;
}

/**
 * Attach real block timestamps. Event blocks carry no wall-clock time, and the
 * frontend's countdowns depend on `deadline`/`runAt` being real seconds — using a
 * block number there would produce nonsense countdowns.
 */
export function hydrateTimestamps(
  model: ReadModel,
  blockTime: Map<bigint, number>,
  /** Restrict the pass to these trials. Without it a per-tick hydrate is O(all trials). */
  onlyTrialIds?: Iterable<number>,
): ReadModel {
  const targets = onlyTrialIds
    ? [...onlyTrialIds].map((id) => model.trials.get(id)).filter((t): t is TrialRow => t !== undefined)
    : model.trials.values();
  // Only a row whose timestamp actually MOVED is a change. The version counter is what
  // invalidates the API's cached snapshot, and this pass runs on every batch — so
  // bumping it unconditionally meant a sync that changed nothing still threw away the
  // cache, every time.
  let moved = false;
  for (const t of targets) {
    const createdAt = blockTime.get(BigInt(t.createdAt)) ?? t.createdAt;
    const runAt = t.runAt === null ? null : (blockTime.get(BigInt(t.runAt)) ?? t.runAt);
    const disputeOpenedAt =
      t.disputeOpenedAt === null ? null : (blockTime.get(BigInt(t.disputeOpenedAt)) ?? t.disputeOpenedAt);
    if (createdAt !== t.createdAt || runAt !== t.runAt || disputeOpenedAt !== t.disputeOpenedAt) {
      moved = true;
    }
    t.createdAt = createdAt;
    t.runAt = runAt;
    t.disputeOpenedAt = disputeOpenedAt;
  }
  if (moved) model.version += 1;
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
    // Off-chain attachments change what a reader sees, so they move the version like any
    // other write — otherwise a cached snapshot would keep serving "awaiting disclosure"
    // after the disclosure had arrived.
    model.version += 1;
  }
  return model;
}

export function attachSignatures(
  model: ReadModel,
  sigs: { trialId: number; signature: string }[],
): ReadModel {
  for (const s of sigs) {
    const r = model.runs.get(s.trialId);
    if (!r) continue;
    r.signature = s.signature;
    model.version += 1;
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

/**
 * How many times the whole model has been deep-copied.
 *
 * The backfill was quadratic once because `replay` copied the entire growing
 * model once per log. A wall-clock test cannot tell that regression apart
 * from a slow machine: on the CI host — which also serves production — the
 * fixed code measured within 30% of the old, and the gate failed for eight
 * days on a box that was thrashing rather than on any change in the code.
 *
 * Counting copies is the same fact without the clock. `replay` must not copy
 * the model at all; `applyEvent`, the pure variant, must copy exactly once.
 * Both are assertions that hold on any machine, at any load, forever.
 */
export const modelCopies = {
  count: 0,
  reset(): void {
    modelCopies.count = 0;
  },
};

function cloneModel(m: ReadModel): ReadModel {
  modelCopies.count += 1;
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
    version: m.version,
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
