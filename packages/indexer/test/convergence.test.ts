import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { encodeAbiParameters, encodeEventTopics, toHex } from "viem";
import { foundry } from "viem/chains";
import { TRIALS_ABI } from "@crucible/smith";
import { Scribe, TRIALS_SOURCE } from "../src/scribe.js";
import {
  agreedView,
  applyArenaEvent,
  applyEvent,
  applyEventInto,
  assertConverged,
  buildSnapshot,
  canonicalOrder,
  compareViews,
  createReplica,
  emptyArenaModel,
  emptyModel,
  projectionView,
  replicaView,
  replay,
  replayArena,
  ReplicaDivergenceError,
  snapshotSignature,
  type AlloyState,
  type EventLike,
  type ReadModel,
  type ReplicaView,
} from "../src/index.js";
import { canonicalJson } from "../src/canonical.js";

/**
 * Two projections of one chain, and the properties that make a second one worth running.
 *
 * The review that asked for "active-active deployment" asked for Postgres with it. That half is a
 * reversal of ADR-0008 (the indexer is in memory by decision) and ADR-0006 (the API holds no chain
 * key), and it is not implemented here. The property underneath the request is real and needs no
 * database: the chain is the sequencer, every indexer is a stateless consumer of one ordered event
 * stream, and N of them must converge on the identical read model — while applying the same log
 * twice must change nothing, because that is what makes a cursor replay safe and therefore what
 * makes a second active replica possible at all.
 *
 * None of that was asserted before. The pieces existed — `replay`, `applyEvent`, `applyEventInto`,
 * `buildSnapshot`, the arena reducer, the sharded reader. What was missing was the claim that they
 * agree, and the check that says loudly when they do not.
 */

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR_ONE = "0x2222222222222222222222222222222222222222";
const OPERATOR_TWO = "0x3333333333333333333333333333333333333333";
const SKEPTIC = "0x4444444444444444444444444444444444444444";
const TRIALS = "0x5555555555555555555555555555555555555555";
/** An address whose EIP-55 form differs from its lowercase form, for the case test below. */
const MIXED_CASE_SEAT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SEAT_A = MIXED_CASE_SEAT.toLowerCase();
const SEAT_B = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const CHAIN_ID = 31337;
const ETH = 10n ** 18n;

/** A hash that names its own position, so a failure can be read without a decoder. */
function hashOf(blockNumber: bigint, logIndex: number): string {
  return `0x${blockNumber.toString(16).padStart(12, "0")}${logIndex.toString(16).padStart(4, "0")}${"0".repeat(48)}`;
}

/** Every log gets its own position and its own transaction hash, the way a node returns them. */
function log(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  logIndex: number,
): EventLike {
  return {
    chainId: CHAIN_ID,
    blockNumber,
    logIndex,
    transactionHash: hashOf(blockNumber, logIndex),
    address: TRIALS,
    eventName,
    args,
  };
}

function trialArgs(id: bigint, reward = ETH, bond = 0n) {
  return {
    id,
    sponsor: SPONSOR,
    specCID: `0x${"f0".repeat(32)}`,
    testsCID: `0x${"f1".repeat(32)}`,
    reward,
    bond,
    deadline: 1_800_000_000n,
    breakWindow: 43_200n,
  };
}

/**
 * One chain's worth of beats: two agents, three trials that settle differently (paid with a break
 * survived, slashed, refunded), a seat vote, a withdrawal, an identity link.
 *
 * Deliberately covers every event the fold counts or decrements, because a convergence claim over
 * two `TrialCreated` logs is a claim about a map insert.
 */
function chain(): EventLike[] {
  return [
    log("AgentRegistered", {
      agentId: 1n, operator: OPERATOR_ONE, runner: OPERATOR_ONE, metadataURI: "ipfs://one", stake: ETH,
    }, 200n, 0),
    log("AgentRegistered", {
      agentId: 2n, operator: OPERATOR_TWO, runner: OPERATOR_TWO, metadataURI: "ipfs://two", stake: ETH,
    }, 200n, 1),

    // trial 1 — claimed, run, broken, disputed, paid
    log("TrialCreated", trialArgs(1n, ETH, ETH / 5n), 201n, 0),
    log("TrialClaimed", { id: 1n, agentId: 1n, bond: ETH / 5n }, 202n, 0),
    log("RunSubmitted", { id: 1n, agentId: 1n, runHash: `0x${"c1".repeat(32)}` }, 203n, 0),
    log("BreakFiled", {
      id: 1n, skeptic: SKEPTIC, proofCID: `0x${"d1".repeat(32)}`, stake: ETH / 10n,
    }, 204n, 0),
    log("DisputeOpened", { id: 1n }, 205n, 0),
    log("VoteCommitted", { id: 1n, judge: SEAT_A }, 206n, 0),
    log("VoteCommitted", { id: 1n, judge: SEAT_B }, 206n, 1),
    log("VoteRevealed", { id: 1n, judge: SEAT_A, breakWins: false }, 207n, 0),
    log("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: (95n * ETH) / 100n }, 208n, 0),

    // trial 2 — claimed by the other agent, run, slashed
    log("TrialCreated", trialArgs(2n, 2n * ETH, ETH / 2n), 210n, 0),
    log("TrialClaimed", { id: 2n, agentId: 2n, bond: ETH / 2n }, 211n, 0),
    log("RunSubmitted", { id: 2n, agentId: 2n, runHash: `0x${"c2".repeat(32)}` }, 212n, 0),
    log("VerdictFinalized", { id: 2n, verdict: 2, agentPayout: 0n }, 213n, 0),

    // trial 3 — claimed, refunded: the bond comes back without a win
    log("TrialCreated", trialArgs(3n, ETH, ETH / 4n), 220n, 0),
    log("TrialClaimed", { id: 3n, agentId: 1n, bond: ETH / 4n }, 221n, 0),
    log("VerdictFinalized", { id: 3n, verdict: 3, agentPayout: 0n }, 222n, 0),

    log("StakeWithdrawn", { agentId: 1n, to: OPERATOR_ONE, amount: ETH / 10n }, 230n, 0),
    log("IdentityLinked", { agentId: 1n, identityAgentId: 4_242n }, 231n, 0),
  ];
}

/** Arena beats, built with the v2 names. Positions are unique for the same reason as `chain()`'s. */
function arenaBeats(): EventLike[] {
  return [
    log("TrialPosted", {
      id: 1n, sponsor: SPONSOR, reward: ETH / 2n, fee: ETH / 20n,
      specDigest: `0x${"11".repeat(32)}`, skepticWindow: 3_600n,
    }, 300n, 0),
    log("TrialClaimed", { id: 1n, agent: OPERATOR_ONE, bond: ETH / 10n, claimDeadline: 1_800_000_000n }, 301n, 0),
    log("RunnerSet", { id: 1n, runner: OPERATOR_TWO }, 302n, 0),
    log("RunSubmitted", { id: 1n }, 303n, 0),
    log("DocketFrozen", { id: 1n }, 304n, 0),
    log("PanelDrawn", { id: 1n, round: 1n }, 305n, 0),
    log("Settled", { id: 1n }, 306n, 0),
    log("TrialPosted", {
      id: 2n, sponsor: SPONSOR, reward: ETH / 5n, fee: ETH / 50n,
      specDigest: `0x${"22".repeat(32)}`, skepticWindow: 1_800n,
    }, 310n, 0),
  ];
}

const ALLOY: AlloyState = {
  tier: 1,
  locked: true,
  tokenUri: "data:x/1",
  epoch: 1,
  epochStartedAt: 1_700_000_000,
  lifetimeWins: 1,
  lifetimeSlashes: 0,
  holder: OPERATOR_ONE,
};

/**
 * The snapshot options every replica is signed with — the same host reads for all of them, or the
 * comparison is comparing the caller rather than the chain.
 *
 * `alloyState` is a registry read that depends on the agent id alone, and `feeBps` is the chain's
 * constant: both are inputs a second API process would supply identically.
 */
const SNAPSHOT = {
  now: 1_700_000_000_000,
  feeBps: 500,
  headTimestamp: 1_700_000_000,
  alloyState: (agentId: number) => ({ ...ALLOY, tier: agentId === 1 ? 1 : 0 }),
};

/**
 * A deterministic shuffle (mulberry32 over Fisher-Yates).
 *
 * No `Math.random()`: a gate that fails one run in sixty because of its own input is the mistake this
 * repository has already recorded making. The seed is the point — the same permutation every run, so
 * a red is reproducible.
 */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const held = out[i]!;
    out[i] = out[j]!;
    out[j] = held;
  }
  return out;
}

/** The same stream, cut into batches of `size`, each internally shuffled. */
function shuffledBatches(events: readonly EventLike[], size: number, seed: number): EventLike[][] {
  const out: EventLike[][] = [];
  for (let i = 0; i < events.length; i += size) {
    out.push(shuffle(events.slice(i, i + size), seed + i));
  }
  return out;
}

/** Fold through the pure `applyEvent`, one log at a time — the path with a clone per step. */
function foldPurely(events: readonly EventLike[]): ReadModel {
  let model = emptyModel();
  for (const ev of events) model = applyEvent(model, ev);
  return model;
}

/** Fold in place, one log at a time — the path that does not clone. */
function foldInPlace(events: readonly EventLike[]): ReadModel {
  let model = emptyModel();
  for (const ev of events) applyEventInto(model, ev);
  return model;
}

/** Replay a stream through a replica, batch by batch. */
function foldAsReplica(name: string, batches: readonly (readonly EventLike[])[]) {
  const replica = createReplica({ name });
  for (const batch of batches) replica.deliver(batch);
  return replica;
}

function canonicalBytes(model: ReadModel): string {
  return canonicalJson(model);
}

describe("convergence: N projections of one chain agree", () => {
  const events = chain();

  /**
   * Seven paths, one answer.
   *
   * `replay` over the whole stream; `applyEventInto` per log; the pure `applyEvent` per log (which
   * deep-copies the model every step, so `cloneModel` is exercised too); a replica fed shuffled
   * batches; a replica fed the entire stream in reverse as ONE batch, which only converges if the
   * reorder is real; a replica handed every log twice in a shuffled interleaving, which is the
   * cursor-replay shape a second active node produces on purpose; and the raw fold handed the whole
   * stream twice, which is what the Scribe does when its cursor stops in front of a range and it asks
   * for that range again.
   */
  it("reaches the same read model by seven different paths", () => {
    const views: ReplicaView[] = [
      replicaView("whole-batch", replay(events), SNAPSHOT),
      replicaView("in-place-one-at-a-time", foldInPlace(events), SNAPSHOT),
      replicaView("pure-one-at-a-time", foldPurely(events), SNAPSHOT),
      foldAsReplica("shuffled-batches", shuffledBatches(events, 4, 1)).view(SNAPSHOT),
      foldAsReplica("reversed-single-batch", [[...events].reverse()]).view(SNAPSHOT),
      foldAsReplica(
        "doubled-shuffled-delivery",
        shuffledBatches(events.flatMap((e) => [e, e]), 7, 11),
      ).view(SNAPSHOT),
      replicaView("doubled-raw-replay", replay([...events, ...events]), SNAPSHOT),
    ];

    expect(compareViews(views)).toEqual([]);
    assertConverged(views);

    // Printed, because "they agree" is the claim and a digest is how anyone else checks it.
    console.log(
      `7 replicas converge: version ${views[0]!.version}, digest ${views[0]!.digest}, ` +
        `signature "${views[0]!.signature}"`,
    );
    // And the serialised model is the same bytes, not merely the same digest.
    for (const view of views) {
      expect(view.state).toBe(views[0]!.state);
      expect(view.signature).toBe(views[0]!.signature);
      expect(view.version).toBe(views[0]!.version);
    }
  });

  it("agrees about the money, not only about the shape", () => {
    // A digest that matched while the ledger disagreed would be the worst possible instrument, so
    // the shared answer is asserted against the chain's own numbers, independently of the comparison.
    const model = replay(events);
    const snap = buildSnapshot(model, SNAPSHOT);
    expect(snap.economics.paidOutEth).toBe("0.95");
    expect(snap.economics.feesEth).toBe("0.05");
    expect(snap.counts.settled).toBe(3);
    expect(model.agents.get(1)!.wins).toBe(1);
    expect(model.agents.get(1)!.survived).toBe(1);
    expect(model.agents.get(1)!.slashes).toBe(0);
    expect(model.agents.get(2)!.slashes).toBe(1);
    // 1 ETH registered; the 0.2 bond moved out at claim and back on the paid verdict, the 0.25 bond
    // out at claim and back on the refund; then a 0.1 withdrawal.
    expect(model.agents.get(1)!.stakeWei).toBe(ETH - ETH / 10n);
    expect(model.agents.get(2)!.stakeWei).toBe(ETH - ETH / 2n);
    expect(
      compareViews([replicaView("a", model, SNAPSHOT), foldAsReplica("b", [events]).view(SNAPSHOT)]),
    ).toEqual([]);
  });

  it("moves the SSE signature when the payload moves, and not when a log is re-read", () => {
    const before = replicaView("a", replay(events), SNAPSHOT).signature;
    // The whole stream again: no new fact, so no frame. This is the ADR-0010 replay-safety claim on
    // the wire — a replica that re-read a range must not invalidate every subscriber's cache.
    const replayed = replay([...events, ...events]);
    expect(replicaView("b", replayed, SNAPSHOT).signature).toBe(before);

    // One more settled win: the counts and the fee move, so the frame gate must move with them.
    const grew = replay([
      ...events,
      log("TrialCreated", trialArgs(4n), 240n, 0),
      log("TrialClaimed", { id: 4n, agentId: 1n, bond: 0n }, 241n, 0),
      log("VerdictFinalized", { id: 4n, verdict: 1, agentPayout: (95n * ETH) / 100n }, 242n, 0),
    ]);
    const after = replicaView("c", grew, SNAPSHOT).signature;
    expect(after).not.toBe(before);
    // And the function is a pure read of the snapshot: same snapshot, same string.
    expect(snapshotSignature(buildSnapshot(grew, SNAPSHOT))).toBe(after);
  });
});

describe("idempotence: the same log twice changes nothing", () => {
  const events = chain();

  it("folds a full re-delivery to the identical model, version included", () => {
    const once = replay(events);
    const twice = replay([...events, ...events]);
    const thrice = replay([...events, ...events, ...events]);

    expect(twice.version).toBe(once.version);
    expect(canonicalBytes(twice)).toBe(canonicalBytes(once));
    expect(canonicalBytes(thrice)).toBe(canonicalBytes(once));
  });

  it("does not subtract a stake that was already withdrawn", () => {
    // The case no state guard covers. `StakeWithdrawn` has nothing to compare against, so before the
    // digest ledger a re-read range decremented the balance again and clamped at zero — a hall row
    // publishing a stake the chain never moved. This is the assertion that fails when the ledger is
    // removed, which is why it stands on its own rather than inside the loop above.
    const registered = log("AgentRegistered", {
      agentId: 1n, operator: OPERATOR_ONE, runner: OPERATOR_ONE, metadataURI: "ipfs://one", stake: ETH,
    }, 200n, 0);
    const withdraw = log("StakeWithdrawn", { agentId: 1n, to: OPERATOR_ONE, amount: (3n * ETH) / 10n }, 230n, 0);

    const single = replay([registered, withdraw]);
    const replayed = replay([registered, withdraw, withdraw]);

    expect(single.agents.get(1)!.stakeWei).toBe((7n * ETH) / 10n);
    expect(replayed.agents.get(1)!.stakeWei).toBe((7n * ETH) / 10n);
    expect(replayed.version).toBe(single.version);
  });

  it("records one verdict per settlement, not two, when the stream is re-read", () => {
    const settled = replay(events);
    const again = replay([...events, ...events]);
    // Agent 1 was in two trials that settled — paid (1) and refunded (3) — so the honest claim is
    // that a re-delivery leaves the receipt list exactly as long as the first fold made it.
    expect(settled.agents.get(1)!.settlements).toHaveLength(2);
    expect(again.agents.get(1)!.settlements).toHaveLength(2);
    expect(canonicalBytes(again)).toBe(canonicalBytes(settled));
    expect(again.agents.get(1)!.wins).toBe(1);
    expect(again.trials.get(1)!.payoutWei).toBe((95n * ETH) / 100n);
    expect(again.disputes.get(1)!.committed).toHaveLength(2);
    expect(settled.version).toBe(again.version);
  });

  it("still refuses a reorged duplicate, which has a new digest", () => {
    // The ledger cannot catch this one and must not be credited with doing it: a reorg re-mines the
    // settling block, so the same logical verdict arrives under a new transaction hash. The state
    // guard (`status === "settled"`) is what keeps the win at one.
    const settled = replay(events);
    const verdict = events.find((e) => e.eventName === "VerdictFinalized" && e.args.id === 1n)!;
    const reorged: EventLike = {
      ...verdict,
      blockNumber: 900n,
      logIndex: 3,
      transactionHash: `0x${"ee".repeat(32)}`,
    };
    const after = applyEventInto(settled, reorged);

    expect(after.agents.get(1)!.wins).toBe(1);
    expect(after.agents.get(1)!.settlements).toHaveLength(2);
    expect(after.version).toBe(settled.version);
  });

  it("does not mistake two different logs for one replay", () => {
    // The other direction. A node cannot put two logs at one position, but a caller can hand the fold
    // two events that share a slot — this repository's own fixtures in `scribe.test.ts` do exactly
    // that, because they exercise decoding rather than sequencing. The digest is of the emission
    // (chain, position, name and arguments), so distinct facts stay distinct and only a true
    // re-delivery is absorbed. A key that deduped this pair would drop a trial off the hall.
    const same = { blockNumber: 500n, logIndex: 0, transactionHash: `0x${"ab".repeat(32)}` };
    const model = replay([
      { ...same, address: TRIALS, chainId: CHAIN_ID, eventName: "TrialCreated", args: trialArgs(1n) },
      { ...same, address: TRIALS, chainId: CHAIN_ID, eventName: "TrialCreated", args: trialArgs(2n) },
    ]);
    expect(model.trials.size).toBe(2);
    expect(model.version).toBe(2);
  });

  it("does not dedupe the same height on two different chains", () => {
    // A chain id is part of the identity because height 230 on 31337 and height 230 on a fork are two
    // different facts. One `Scribe` indexes one chain, so this cannot happen inside a running index —
    // which is exactly why the digest must not be the thing that quietly allows it later.
    const registered = log("AgentRegistered", {
      agentId: 1n, operator: OPERATOR_ONE, runner: OPERATOR_ONE, metadataURI: "ipfs://one", stake: ETH,
    }, 200n, 0);
    const withdraw = log("StakeWithdrawn", { agentId: 1n, to: OPERATOR_ONE, amount: (3n * ETH) / 10n }, 230n, 0);
    const otherChain = { ...withdraw, chainId: CHAIN_ID + 1 };

    const folded = replay([registered, withdraw, otherChain]);
    expect(folded.agents.get(1)!.stakeWei).toBe((4n * ETH) / 10n);
    expect(folded.appliedLogs.size).toBe(3);
  });
});

describe("out-of-order delivery: reorder within a batch, refuse across batches", () => {
  const events = chain();

  it("folds a shuffled batch in the chain's order, not the arrival order", () => {
    const replica = createReplica({ name: "shuffled" });
    const report = replica.deliver(shuffle(events, 7));

    expect(report.refusals).toHaveLength(0);
    expect(report.duplicates).toBe(0);
    expect(replica.model.version).toBe(replay(events).version);
    expect(canonicalBytes(replica.model)).toBe(canonicalBytes(replay(events)));
    // The cursor is the highest position folded, which is also the last one in chain order.
    expect(replica.cursor).toEqual({ blockNumber: 231n, logIndex: 0 });
  });

  /**
   * The negative, and it is the reason the reorder is not decoration.
   *
   * A projection that silently folds an out-of-order event reports a state the chain never had. Here
   * the same stream reversed through the raw fold produces a *different* read model — a settled trial
   * with no agent behind it, wins the chain did not award — so "sorting recovers the fact" is a real
   * claim about a real divergence, not a test of a no-op.
   */
  it("does not converge when the same events are folded without the reorder", () => {
    const reversed = [...events].reverse();
    const sorted = replicaView("sorted", replay(canonicalOrder(reversed)), SNAPSHOT);
    const asArrived = replicaView("as-arrived", replay(reversed), SNAPSHOT);

    const differences = compareViews([sorted, asArrived]);
    expect(differences).not.toEqual([]);
    expect(differences.join(" ")).toContain("reads the chain differently");
    expect(() => assertConverged([sorted, asArrived])).toThrow(ReplicaDivergenceError);
    // Named so the failure is legible: the fold that took the logs as they came lost a paid win.
    expect(replay(reversed).agents.get(1)!.wins).toBeLessThan(replay(events).agents.get(1)!.wins);
  });

  it("refuses a log from behind the cursor instead of folding backwards into the model", () => {
    const refusals: string[] = [];
    const replica = createReplica({ name: "live", onRefusal: (r) => refusals.push(r.reason) });
    replica.deliver(events);

    const version = replica.model.version;
    const bytes = canonicalBytes(replica.model);
    // A log this projection has never seen — so it is not a duplicate — from a block it already
    // passed. Folding it would splice a past prefix into a live model.
    const late = log("TrialCreated", trialArgs(9n), 150n, 0);
    const report = replica.deliver([late]);

    expect(report.folded).toBe(0);
    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]!.reason).toBe("below-cursor");
    expect(report.refusals[0]!.event).toBe(late);
    expect(report.refusals[0]!.cursor).toEqual({ blockNumber: 231n, logIndex: 0 });
    expect(refusals).toEqual(["below-cursor"]);
    expect(replica.model.version).toBe(version);
    expect(canonicalBytes(replica.model)).toBe(bytes);
    expect(replica.totals.refusals).toBe(1);

    // And the consequence is stated, not implied: a replica that folded this would be describing a
    // chain whose block 150 came after block 231. The check says so rather than serving whichever
    // projection answered first.
    const naive = replay([...events, late]);
    const differences = compareViews([replica.view(SNAPSHOT), replicaView("naive", naive, SNAPSHOT)]);
    expect(differences.join(" ")).toContain("reads the chain differently");

    // A re-delivery of the same range is NOT a refusal: it is what a stopped cursor does, and calling
    // it one would bury the real signal under an every-tick warning.
    const reread = replica.deliver(events);
    expect(reread.refusals).toHaveLength(0);
    expect(reread.duplicates).toBe(events.length);
    expect(reread.folded).toBe(0);
  });

  it("counts the delivery rather than asserting it silently", () => {
    const replica = createReplica({ name: "bookkeeper" });
    const first = replica.deliver(events);
    expect(first.delivered).toBe(events.length);
    expect(first.folded).toBe(events.length);
    expect(first.duplicates).toBe(0);
    expect(first.version).toBe(replica.model.version);

    const second = replica.deliver(events.slice(0, 5));
    expect(second.delivered).toBe(5);
    expect(second.duplicates).toBe(5);
    expect(second.folded).toBe(0);
    expect(replica.totals).toEqual({
      delivered: events.length + 5,
      folded: events.length,
      duplicates: 5,
      refusals: 0,
    });
  });
});

describe("the canonical form is a measurement, not a print", () => {
  /** The same projection with every Map rebuilt in the opposite insertion order. */
  function reordered(model: ReadModel): ReadModel {
    const copy = emptyModel();
    for (const [k, v] of [...model.trials.entries()].reverse()) copy.trials.set(k, v);
    for (const [k, v] of [...model.agents.entries()].reverse()) copy.agents.set(k, v);
    for (const [k, v] of [...model.runs.entries()].reverse()) copy.runs.set(k, v);
    for (const [k, v] of [...model.disputes.entries()].reverse()) copy.disputes.set(k, v);
    for (const k of [...model.appliedLogs].reverse()) copy.appliedLogs.add(k);
    copy.version = model.version;
    return copy;
  }

  it("prints the same bytes for the same facts, whatever order they were stored in", () => {
    // The fold writes rows in the order the logs arrived, so two replicas that legitimately agree can
    // still hold their Maps in different orders. A comparison keyed on insertion order would report
    // that as a divergence, and the day it does, the check stops being believed.
    const model = replay(chain());
    expect(canonicalJson(reordered(model))).toBe(canonicalJson(model));
    expect(projectionView("a", model).digest).toBe(projectionView("b", reordered(model)).digest);
    expect(compareViews([projectionView("a", model), projectionView("b", reordered(model))])).toEqual([]);
  });

  it("keeps a wei amount exact, so a money difference cannot round its way into agreement", () => {
    const one = replay(chain());
    const other = replay(chain());
    one.agents.get(1)!.stakeWei = 900000000000000000n;
    other.agents.get(1)!.stakeWei = 900000000000000001n;
    expect(canonicalJson(one)).not.toBe(canonicalJson(other));
    // A bigint and the number it equals must not print alike: the model holds wei, and a float there
    // is the bug `weiToEth` exists to prevent.
    expect(canonicalJson({ v: 1n })).not.toBe(canonicalJson({ v: 1 }));
    expect(canonicalJson({ v: 1n })).not.toBe(canonicalJson({ v: "1" }));
  });

  it("refuses to print a value it cannot name, rather than printing something plausible", () => {
    // A function in a read model means somebody attached behaviour to state; hashing it would make
    // two different behaviours look identical. Loud is the only correct answer.
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/no canonical form/);
  });
});

describe("divergence is reported, not absorbed", () => {
  const events = chain();

  function viewOf(model: ReadModel, name: string): ReplicaView {
    return replicaView(name, model, SNAPSHOT);
  }

  it("reports no difference between two identical projections", () => {
    const a = viewOf(replay(events), "a");
    const b = viewOf(foldPurely(events), "b");
    expect(compareViews([a, b])).toEqual([]);
    expect(() => assertConverged([a, b])).not.toThrow();
  });

  it("names both replicas and the byte where they part, when one is behind", () => {
    const full = viewOf(replay(events), "full");
    const behind = viewOf(replay(events.slice(0, -1)), "behind");

    const differences = compareViews([full, behind]);
    const report = differences.join(" ");
    expect(differences.length).toBeGreaterThan(0);
    expect(report).toContain("behind");
    expect(report).toContain("full");
    expect(report).toContain("byte");
    expect(() => assertConverged([full, behind])).toThrow(/diverged/);
    // Stated because it is uncomfortable and load-bearing: the last log here is an identity link,
    // which moves the read model and the hall row but NOT the frame gate, because the field list the
    // SSE pump hashes does not name it. The byte comparison is what catches a divergence the
    // signature cannot see. See `snapshotSignature` in api.ts.
    expect(full.signature).toBe(behind.signature);
  });

  it("reports a frame-gate disagreement as its own failure", () => {
    // The other half: a registry tier that a second host read differently. Same chain, same
    // projection, different published row — which is a duplicate frame or a missing one, not a
    // stale model. A comparison that only diffed the read model would call this agreement.
    const model = replay(events);
    const iron = replicaView("iron", model, { ...SNAPSHOT, alloyState: () => ({ ...ALLOY, tier: 1 }) });
    const unforged = replicaView("unforged", model, { ...SNAPSHOT, alloyState: () => ({ ...ALLOY, tier: 0 }) });

    expect(iron.digest).toBe(unforged.digest);
    expect(iron.version).toBe(unforged.version);
    const differences = compareViews([iron, unforged]);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain("publishes SSE signature");
    expect(() => assertConverged([iron, unforged])).toThrow(ReplicaDivergenceError);
  });

  it("treats a single wei of difference as a failure", () => {
    // Money: two models with the same counters, the same version history, differing only in what the
    // chain paid. An instrument that cannot see this cannot see anything.
    const a = replay(events);
    const b = replay(events);
    b.trials.get(1)!.payoutWei = (95n * ETH) / 100n - 1n;

    const differences = compareViews([viewOf(a, "a"), viewOf(b, "b")]);
    expect(differences.join(" ")).toContain("byte");
    // The payload's own books move with it, so the frame gate sees this one too.
    expect(buildSnapshot(b, SNAPSHOT).economics.paidOutEth).not.toBe(
      buildSnapshot(a, SNAPSHOT).economics.paidOutEth,
    );
    expect(compareViews([viewOf(a, "a"), viewOf(b, "b")]).join(" ")).toContain("publishes SSE signature");
  });

  it("refuses to call one projection a converged fleet", () => {
    const one = viewOf(replay(events), "solo");
    expect(compareViews([one])).toEqual([
      "one projection was given: convergence is a claim about two or more",
    ]);
    expect(compareViews([])).toEqual(["no projections were given, so nothing was compared"]);
    expect(() => assertConverged([one])).toThrow(/two or more/);
    expect(() => assertConverged([])).toThrow(/nothing was compared/);
  });

  it("says so when two replicas do not even expose the same stream surface", () => {
    // The arena model has no SSE signature. Comparing it against the trials projection must not be
    // able to "agree" by both sides inventing an empty string.
    const arena = projectionView("arena", replayArena(arenaBeats()));
    const trials = viewOf(replay(events), "trials");
    expect(compareViews([trials, arena]).join(" ")).toContain("no SSE signature");
  });

  it("refuses to answer from a fleet that disagrees, and answers from one that does not", () => {
    // The shape an active-active host actually faces: it has to return *something*. Taking the first
    // replica's answer because it arrived first is the failure this guards, and the guard has to be
    // able to say so out loud.
    const full = replay(events);
    const behind = replay(events.slice(0, -3));
    expect(() => agreedView([viewOf(full, "first"), viewOf(behind, "second")])).toThrow(
      ReplicaDivergenceError,
    );

    const a = viewOf(full, "first");
    const b = foldAsReplica("second", shuffledBatches(events, 3, 29)).view(SNAPSHOT);
    expect(agreedView([a, b]).digest).toBe(a.digest);
  });

  it("carries the whole report on the error, not just its first line", () => {
    const a = viewOf(replay(events), "a");
    const b = viewOf(replay(events.slice(0, -2)), "b");
    try {
      assertConverged([a, b]);
      expect.unreachable("a diverged fleet must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplicaDivergenceError);
      const divergence = err as ReplicaDivergenceError;
      expect(divergence.differences.length).toBeGreaterThan(0);
      expect(divergence.views.map((v) => v.name)).toEqual(["a", "b"]);
    }
  });
});

describe("the arena projection converges under the same rules", () => {
  it("reaches the same arena model whole, one at a time, and out of order", () => {
    const beats = arenaBeats();
    const whole = replayArena(beats);
    let stepwise = emptyArenaModel();
    for (const ev of beats) stepwise = applyArenaEvent(stepwise, ev).model;
    const reordered = replayArena(canonicalOrder(shuffle(beats, 3)));
    const doubled = replayArena(canonicalOrder(beats.flatMap((e) => [e, e])));

    const views = [
      projectionView("whole", whole),
      projectionView("stepwise", stepwise),
      projectionView("reordered", reordered),
      projectionView("doubled", doubled),
    ];
    expect(compareViews(views)).toEqual([]);
    // Eight beats, eight changes: post, claim, runner, run, docket, panel, settle, post.
    expect(whole.version).toBe(8);
    expect(whole.trials.get(1)!.status).toBe("settled");
    expect(whole.trials.get(2)!.status).toBe("open");
  });

  /**
   * The same negative control against the *other* reducer.
   *
   * `canonicalOrder` is one statement of the chain's sequence, used by the transport's shard merge
   * and by both projections; it is asserted here too because a rule only one consumer follows is not
   * a rule.
   */
  it("does not converge when the arena stream is folded as it arrived", () => {
    const beats = arenaBeats();
    const reversed = [...beats].reverse();
    const sorted = projectionView("ordered", replayArena(canonicalOrder(reversed)));
    const asArrived = projectionView("as-arrived", replayArena(reversed));

    const differences = compareViews([sorted, asArrived]);
    expect(differences).not.toEqual([]);
    expect(differences.join(" ")).toContain("reads the chain differently");
    // The chain's own answer, named: a settled trial that the unsorted fold left open.
    expect(replayArena(beats).trials.get(1)!.status).toBe("settled");
    expect(asArrived.state).not.toBe(sorted.state);
  });
});

describe("two indexers of one chain, through the transport that actually runs", () => {
  /**
   * Three `Scribe`s against one chain, over real HTTP, with viem decoding the logs.
   *
   * This is the closest thing the repository can build to two deployed indexers, and the whole
   * argument for running more than one depends on it: one reads the range in a single call, one is
   * sharded into four-block windows whose logs come back newest-first, one faces a node that ignores
   * the range filter and answers every window with the entire tail. Identical bytes, identical
   * version, identical frame gate — or the second replica is a liability rather than a redundancy.
   */
  it("converges however the node chooses to answer", async () => {
    const logs = rpcChain();
    const nodes = await Promise.all([
      chainNode(logs, "exact"),
      chainNode(logs, "reversedWithinWindow"),
      chainNode(logs, "wholeRange"),
    ]);

    try {
      const indexed: { name: string; model: ReadModel; status: Scribe["status"]; serves: Serve[] }[] = [];
      for (const [name, node, shardSizeBlocks] of [
        ["single-window", nodes[0], 0n],
        ["sharded-reversed", nodes[1], 4n],
        ["lying-node", nodes[2], 4n],
      ] as const) {
        const scribe = new Scribe({
          source: { ...TRIALS_SOURCE, address: TRIALS },
          chain: foundry,
          rpcUrl: node.url,
          fromBlock: 0n,
          shardSizeBlocks,
        });
        await scribe.sync();
        indexed.push({ name, model: scribe.state, status: scribe.status, serves: node.serves });
      }

      const views = indexed.map((s) => replicaView(s.name, s.model, SNAPSHOT));
      expect(compareViews(views)).toEqual([]);
      assertConverged(views);

      // The instrument proves it ran the case: the sharded reads really were split across windows, the
      // reversed node really answered at least one window newest-first, and the lying node really
      // served logs from outside the window it was asked about. Without these three the test could
      // pass with every Scribe reading the chain the same way, which would prove nothing about order.
      const sharded = indexed[1]!;
      const lying = indexed[2]!;
      expect(sharded.serves.length).toBeGreaterThan(1);
      expect(lying.serves.length).toBeGreaterThan(1);
      expect(sharded.serves.some((s) => s.descending)).toBe(true);
      expect(sharded.serves.every((s) => s.outside === 0)).toBe(true);
      expect(lying.serves.some((s) => s.outside > 0)).toBe(true);

      // Agreement is also agreement about the chain: the end state, asserted rather than only compared.
      for (const s of indexed) {
        expect(s.model.trials.get(1)!.status).toBe("settled");
        expect(s.model.agents.get(1)!.wins).toBe(1);
        expect(s.model.agents.get(1)!.survived).toBe(1);
        expect(s.model.agents.get(1)!.identityAgentId).toBe(4_242n);
        expect(s.model.agents.get(2)!.slashes).toBe(1);
        expect(s.model.disputes.get(1)!.committed).toEqual([SEAT_A, SEAT_B]);
        // 1 ETH registered, 0.1 withdrawn. The claim's bond moved out at claim and back on the paid
        // verdict, so the free balance is what the chain holds and not a re-derivation of it.
        expect(s.model.agents.get(1)!.stakeWei).toBe((9n * ETH) / 10n);
        // The quiet tail was proved, so the index is caught up rather than stalled: cursor is
        // head + 1, which ADR-0010 defines as the caught-up state.
        expect(s.status.indexedTo).toBe(41n);
        expect(s.status.syncError).toBeNull();
      }
      console.log(
        `3 indexers over real JSON-RPC converge: version ${views[0]!.version}, digest ${views[0]!.digest}`,
      );
    } finally {
      nodes.forEach((n) => n.close());
    }
  });

  it("does not double-count when a lying node answers every window with the whole tail", async () => {
    // The double-counting case in the rough, on the path that actually ships: the same log arrives
    // once per window, out of order, inside one batch. Assert the end state — one win, one receipt,
    // one identity link — and then re-fold the very batch the transport produced.
    const logs = rpcChain();
    const node = await chainNode(logs, "wholeRange");
    try {
      let batch: EventLike[] = [];
      const scribe = new Scribe({
        source: { ...TRIALS_SOURCE, address: TRIALS },
        chain: foundry,
        rpcUrl: node.url,
        fromBlock: 0n,
        shardSizeBlocks: 4n,
        onEvents: (events) => {
          batch = [...batch, ...events];
        },
      });
      await scribe.sync();

      expect(scribe.state.agents.get(1)!.wins).toBe(1);
      expect(scribe.state.agents.get(1)!.settlements).toHaveLength(1);
      expect(scribe.state.agents.get(1)!.stakeWei).toBe((9n * ETH) / 10n);
      // More deliveries than events, because the node lied about every window.
      expect(batch.length).toBeGreaterThan(logs.length);

      const before = scribe.state.version;
      const refolded = replay(batch, scribe.state);
      expect(refolded.version).toBe(before);
      expect(refolded.agents.get(1)!.wins).toBe(1);
      expect(refolded.agents.get(1)!.settlements).toHaveLength(1);
      expect(refolded.trials.size).toBe(2);
    } finally {
      node.close();
    }
  });
});

describe("two transports that spell an address differently still agree", () => {
  it("does not treat the same log as new because a proxy changed its case", () => {
    // viem returns a decoded `address` EIP-55 checksummed; another gateway returns it lowercase. Both
    // describe the same emission, so an identity that depended on the spelling would fold one
    // replica's logs twice and the other's once — two indexers of one chain, two answers, and the
    // stake is where it shows.
    const registered = log("AgentRegistered", {
      agentId: 1n, operator: MIXED_CASE_SEAT, runner: MIXED_CASE_SEAT, metadataURI: "ipfs://one", stake: ETH,
    }, 200n, 0);
    const checksummed = log("StakeWithdrawn", { agentId: 1n, to: MIXED_CASE_SEAT, amount: ETH / 5n }, 210n, 0);
    const lowercase: EventLike = {
      ...checksummed,
      args: { agentId: 1n, to: MIXED_CASE_SEAT.toLowerCase(), amount: ETH / 5n },
    };

    const both = replay([registered, checksummed, lowercase]);
    const once = replay([registered, checksummed]);

    expect(both.agents.get(1)!.stakeWei).toBe((4n * ETH) / 5n);
    expect(both.version).toBe(once.version);
    expect(canonicalBytes(both)).toBe(canonicalBytes(once));
  });
});

/** One window the mock was asked about, and what it chose to answer with. */
interface Serve {
  readonly from: number;
  readonly to: number;
  readonly count: number;
  /** Logs returned that were outside the requested range. */
  readonly outside: number;
  /** Whether the response was not in ascending block order. */
  readonly descending: boolean;
}

/**
 * A node that answers the indexer over real JSON-RPC, in whatever order it chooses.
 *
 * `reversedWithinWindow` and `wholeRange` are not abstractions: they are the two shapes the transport
 * has to survive. A proxy that returns a window newest-first, and a node that ignores a range filter
 * and answers every window with the whole tail, both hand the fold a batch that is not in chain
 * order, and the second hands it the same log up to once per window. The claim under test is that the
 * read model does not care — so the mock has to be able to do those things, and has to record that
 * it did (see `serves`).
 */
async function chainNode(
  logs: Record<string, unknown>[],
  behaviour: "exact" | "reversedWithinWindow" | "wholeRange",
): Promise<{ url: string; serves: Serve[]; close: () => void }> {
  const head = 40;
  const quietBloom = toHex(new Uint8Array(256));
  const blockFor = (n: number) => ({
    number: toHex(n),
    hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"22".repeat(32)}`,
    nonce: "0x0",
    sha3Uncles: `0x${"33".repeat(32)}`,
    logsBloom: quietBloom,
    transactionsRoot: `0x${"44".repeat(32)}`,
    stateRoot: `0x${"55".repeat(32)}`,
    receiptsRoot: `0x${"66".repeat(32)}`,
    miner: `0x${"00".repeat(20)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    // A distinct timestamp per block, so hydration has something real to move — and every replica
    // moves it to the same seconds.
    timestamp: toHex(1_700_000_000 + n),
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x0",
  });

  const blockOf = (l: Record<string, unknown>) => Number(BigInt(l.blockNumber as string));
  const serves: Serve[] = [];
  const answer = (method: string, params: unknown[]): unknown => {
    if (method === "eth_blockNumber") return toHex(head);
    if (method === "eth_chainId") return toHex(foundry.id);
    if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock?: string; toBlock?: string };
      const from = Number(BigInt(filter.fromBlock ?? "0x0"));
      const to = Number(BigInt(filter.toBlock ?? "0x0"));
      const chosen =
        behaviour === "wholeRange" ? logs : logs.filter((l) => blockOf(l) >= from && blockOf(l) <= to);
      const out = behaviour === "exact" ? chosen : [...chosen].reverse();
      let descending = false;
      for (let i = 1; i < out.length; i++) {
        if (blockOf(out[i - 1]!) > blockOf(out[i]!)) descending = true;
      }
      serves.push({
        from,
        to,
        count: out.length,
        outside: out.filter((l) => blockOf(l) < from || blockOf(l) > to).length,
        descending,
      });
      return out;
    }
    if (method === "eth_getBlockByNumber" || method === "eth_getBlock") {
      const first = params[0];
      const raw =
        typeof first === "object" && first !== null
          ? (first as { blockNumber?: string }).blockNumber
          : (first as string | undefined);
      return blockFor(Number(raw ? BigInt(raw) : 0n));
    }
    return blockFor(0);
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { id: number; method: string; params?: unknown[] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: answer(parsed.method, parsed.params ?? []) }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, serves, close: () => server.close() };
}

/** One ABI-encoded log, shaped the way a node returns it: hex quantities, nothing pre-decoded. */
function rpcLog(
  eventName: string,
  values: Record<string, unknown>,
  block: number,
  index: number,
): Record<string, unknown> {
  const item = TRIALS_ABI.find((i) => i.type === "event" && i.name === eventName);
  if (!item || item.type !== "event" || item.inputs === undefined) {
    throw new Error(`${eventName} is not an event in TRIALS_ABI`);
  }
  const indexed = item.inputs.filter((i) => "indexed" in i && i.indexed);
  const plain = item.inputs.filter((i) => !("indexed" in i && i.indexed));
  const topics = encodeEventTopics({
    abi: TRIALS_ABI,
    eventName,
    args: Object.fromEntries(indexed.map((i) => [i.name, values[i.name]])),
  } as never) as `0x${string}`[];
  const data = encodeAbiParameters(
    plain.map(({ name: _n, indexed: _i, ...rest }) => rest) as never,
    plain.map((i) => values[i.name]) as never,
  );
  return {
    address: TRIALS,
    blockNumber: toHex(block),
    transactionHash: hashOf(BigInt(block), index),
    logIndex: toHex(index),
    transactionIndex: "0x0",
    blockHash: `0x${"11".repeat(32)}`,
    removed: false,
    data,
    topics,
  };
}

/**
 * The same story `chain()` tells, as the bytes a node would put on the wire.
 *
 * Encoded from the ABI rather than hand-written, because a fixture that hands the indexer
 * `eventName` and `args` pre-decoded describes a transport that does not exist — the exact mistake
 * that let the replay route pass its suite and answer an empty replay on a real chain.
 */
function rpcChain(): Record<string, unknown>[] {
  return [
    rpcLog("AgentRegistered", {
      agentId: 1n, operator: OPERATOR_ONE, runner: OPERATOR_ONE, metadataURI: "ipfs://one", stake: ETH,
    }, 10, 0),
    rpcLog("TrialCreated", {
      id: 1n, sponsor: SPONSOR, specCID: `0x${"a1".repeat(32)}`, testsCID: `0x${"b1".repeat(32)}`,
      reward: ETH, bond: ETH / 5n, deadline: 1_800_000_000, breakWindow: 43_200,
    }, 11, 0),
    rpcLog("TrialClaimed", { id: 1n, agentId: 1n, bond: ETH / 5n }, 12, 0),
    rpcLog("RunSubmitted", { id: 1n, agentId: 1n, runHash: `0x${"c1".repeat(32)}` }, 12, 1),
    rpcLog("BreakFiled", {
      id: 1n, skeptic: SKEPTIC, proofCID: `0x${"d1".repeat(32)}`, stake: ETH / 10n,
    }, 13, 0),
    rpcLog("VoteCommitted", { id: 1n, judge: SEAT_A }, 13, 1),
    rpcLog("VoteCommitted", { id: 1n, judge: SEAT_B }, 13, 2),
    rpcLog("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: (95n * ETH) / 100n }, 14, 0),
    rpcLog("AgentRegistered", {
      agentId: 2n, operator: OPERATOR_TWO, runner: OPERATOR_TWO, metadataURI: "ipfs://two", stake: ETH,
    }, 20, 0),
    rpcLog("TrialCreated", {
      id: 2n, sponsor: SPONSOR, specCID: `0x${"a2".repeat(32)}`, testsCID: `0x${"b2".repeat(32)}`,
      reward: 2n * ETH, bond: ETH / 2n, deadline: 1_800_001_000, breakWindow: 86_400,
    }, 21, 0),
    rpcLog("TrialClaimed", { id: 2n, agentId: 2n, bond: ETH / 2n }, 22, 0),
    rpcLog("VerdictFinalized", { id: 2n, verdict: 2, agentPayout: 0n }, 23, 0),
    rpcLog("StakeWithdrawn", { agentId: 1n, to: OPERATOR_ONE, amount: ETH / 10n }, 30, 0),
    rpcLog("IdentityLinked", { agentId: 1n, identityAgentId: 4_242n }, 31, 0),
  ];
}
