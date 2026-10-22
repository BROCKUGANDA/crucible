import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunFacts, VerifyReport } from "@crucible/argus";
import type { Address, Hex } from "viem";
import { DurableSeat, type SeatCast } from "../src/cast.js";
import { Crucible } from "@crucible/smith";
import type { VotePoster } from "../src/chain.js";
import { NO_COMMIT, STATUS_CHALLENGED, type DisputeView, type SeatConstants } from "../src/policy.js";
import { createOperator, type ChainPort, type IndexPort, type JudgePort } from "../src/operator.js";
import { FileState, MemoryState, type VoteState } from "../src/state.js";

/**
 * The operator's decision logic, with no chain, no clock and no container.
 *
 * Every dependency the pass touches is injected — the verifier, the poster, the dispute state,
 * the clock, the store — so what is under test here is the wiring of the rules, not viem. The
 * point of doing it this way is the mutation runs at the bottom of this file's description: a
 * test that cannot fail against an inverted condition is worse than no test in this repository,
 * and each of these five branches has a name, a reason, and a broken alternative.
 *
 * The five that must not regress:
 *   - an abstention casts nothing;
 *   - a `break-wins` verdict seals `true`, and unseals only once two seats have sealed;
 *   - a restart between the two still reveals, from the durable store;
 *   - a seat that already sealed does not seal again;
 *   - a closed commit window is never even verified.
 */

const SEAT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const PEER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const PEER2 = "0x90F7947807cD61A09c50d7fA3b0A2A4d8d2F7F0b" as const;

const OPENED_AT = 1_800_000_000;
const HASH: Hex = `0x${"cd".repeat(32)}`;

const CONSTANTS: SeatConstants = {
  // Mirrors the contract's shape: 24h window, 2-of-3 quorum, and a re-run budget the seat must
  // finish inside.
  commitWindowSec: 86_400,
  threshold: 2,
  marginSec: 960,
};

const RUN_HASH: Hex = `0x${"aa".repeat(32)}`;

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    verdict: "break-wins",
    phase: "deterministic",
    steps: [],
    reason: "the re-run does not reproduce the claim",
    ...over,
  } as VerifyReport;
}

interface Fixture {
  operator: ReturnType<typeof createOperator>;
  /** the seat's own memory — swapped by the restart test */
  state: VoteState;
  cast: SeatCast;
  commits: { trialId: number; commit: Hex }[];
  reveals: { trialId: number; breakWins: boolean; salt: Hex }[];
  verified: number[];
  disputeReads: number;
  logs: string[];
  setView(trialId: number, patch: Partial<DisputeView>): void;
  setVerdict(r: VerifyReport | ((id: number) => VerifyReport)): void;
  now: number;
  wall: number;
}

function view(trialId: number, patch: Partial<DisputeView> = {}): DisputeView {
  return {
    trialId,
    // The view is read *for* a seat, and the rules answer per-seat questions, so a view without
    // one is not a fixture — it is a seat that is nobody.
    seat: SEAT,
    status: STATUS_CHALLENGED,
    openedAt: OPENED_AT,
    committed: [],
    revealed: [],
    seatCommit: NO_COMMIT,
    seatRevealed: false,
    ...patch,
  };
}

async function harness(opts: { stateDir?: string; initial?: VerifyReport } = {}): Promise<Fixture> {
  const fixture: Partial<Fixture> & {
    views: Map<number, DisputeView>;
    verdict: VerifyReport | ((id: number) => VerifyReport);
  } = {
    views: new Map([[7, view(7)]]),
    verdict: opts.initial ?? report(),
    commits: [],
    reveals: [],
    verified: [],
    disputeReads: 0,
    logs: [],
    now: OPENED_AT + 60,
    wall: 10_000,
  };
  const views = fixture.views!;

  const state: VoteState = opts.stateDir ? await FileState.open(opts.stateDir) : new MemoryState();

  const poster: VotePoster = {
    commitVote: async (trialId, commit) => {
      fixture.commits!.push({ trialId, commit });
      // The real contract records the commitment; mirror that so a second pass sees the same
      // word the chain would, and a test cannot accidentally pass by leaving it at zero.
      //
      // A view this harness never seeded is still a trial the chain can accept a commit for — a
      // fake that required its own map to be pre-populated would make any test using an id it did
      // not declare fail inside the fake rather than inside the code under test.
      const v = views.get(trialId) ?? view(trialId);
      views.set(trialId, { ...v, seatCommit: commit, committed: [...v.committed, SEAT.toLowerCase()] });
      return HASH;
    },
    revealVote: async (trialId, breakWins, salt) => {
      fixture.reveals!.push({ trialId, breakWins, salt });
      const v = views.get(trialId) ?? view(trialId);
      views.set(trialId, {
        ...v,
        seatRevealed: true,
        revealed: [...v.revealed, SEAT.toLowerCase()],
      });
      return HASH;
    },
  };

  const cast = new DurableSeat({ poster, state, seat: SEAT });

  const chain: ChainPort = {
    chainNow: async () => fixture.now!,
    disputeView: async (trialId, votes) => {
      fixture.disputeReads! += 1;
      const base = views.get(trialId) ?? view(trialId);
      // The votes always come from the projection, exactly as the real adapter passes them
      // through — a fixture that ignored the argument would hide a wiring bug in `main.ts`.
      return { ...base, committed: votes.committed, revealed: votes.revealed };
    },
  };

  const judge: JudgePort = {
    facts: async (trialId) =>
      ({
        trialId,
        agentId: 3,
        runHash: RUN_HASH,
        chainId: 31337,
        verifyingContract: "0x5fbdb2315678afecb367f032d93f642f63180aa3" as Address,
        runner: PEER2,
        sigDeadline: 1n,
      }) satisfies RunFacts,
    verify: async (facts) => {
      fixture.verified!.push(facts.trialId);
      return typeof fixture.verdict === "function" ? fixture.verdict(facts.trialId) : fixture.verdict;
    },
  };

  const index: IndexPort = {
    candidates: () => [...views.keys()],
    votes: (trialId) => {
      const v = views.get(trialId);
      return { committed: v?.committed ?? [], revealed: v?.revealed ?? [] };
    },
  };

  const operator = createOperator({
    seat: SEAT,
    constants: CONSTANTS,
    chain,
    index,
    judge,
    cast,
    state,
    reverifyMs: 900_000,
    wallNow: () => fixture.wall!,
    log: (line) => fixture.logs!.push(line),
  });

  const f = fixture as Fixture;
  f.state = state;
  f.cast = cast;
  f.operator = operator;
  f.setView = (trialId, patch) => {
    views.set(trialId, { ...view(trialId), ...(views.get(trialId) ?? {}), ...patch });
  };
  f.setVerdict = (r) => {
    fixture.verdict = r;
  };
  return f;
}

describe("the seat operator's pass", () => {
  it("casts no commitment for an abstention, and records why", async () => {
    const f = await harness({
      initial: report({ verdict: "abstain", phase: "abstain", reason: "the pinned suite could not be re-executed" }),
    });

    const result = await f.operator.pass();

    expect(f.commits).toEqual([]);
    expect(result.counts.abstain).toBe(1);
    expect(f.logs.join("\n")).toContain("no commitment is cast for an abstention");

    // Recorded durably: an abstention that vanishes on restart turns one slow pass into a
    // container run every thirty seconds, forever.
    const abstained = await f.state.abstention(7);
    expect(abstained?.reason).toBe("the pinned suite could not be re-executed");
    expect(abstained?.phase).toBe("abstain");
  });

  it("seals a break-wins verdict as true, then reveals once two seats have sealed", async () => {
    const f = await harness();

    const first = await f.operator.pass();
    expect(f.commits).toHaveLength(1);
    expect(first.counts.commit).toBe(1);

    // The commitment is what the contract will re-hash on reveal: keccak256(abi.encodePacked(
    // uint256 id, bool breakWins, bytes32 salt)). Rebuilding it here from the salt the seat
    // stored is what proves the stored salt is the one that was posted.
    const sealed = (await f.state.get(7))!;
    expect(f.commits[0]!.commit).toBe(Crucible.commit(7n, true, sealed.salt));

    // One seal — the seat's own. ADR-0004: it must not unseal yet, or it is voting before the
    // committee exists.
    await f.operator.pass();
    expect(f.reveals).toEqual([]);

    f.setView(7, { committed: [SEAT.toLowerCase(), PEER.toLowerCase()] });
    const third = await f.operator.pass();

    expect(f.reveals).toHaveLength(1);
    expect(f.reveals[0]).toMatchObject({ trialId: 7, breakWins: true });
    expect(third.counts.reveal).toBe(1);
    // Opened salt is worthless; keeping it would have the loop re-read a finished dispute.
    expect(await f.state.get(7)).toBeNull();
  });

  it("waits for the quorum count and does not reveal on one seal", async () => {
    const f = await harness();
    await f.operator.pass();
    const before = await f.operator.pass();

    expect(f.reveals).toEqual([]);
    expect(before.actions.find((a) => a.trialId === 7 && a.action === "hold")?.detail).toContain(
      "waiting for 2 seats to seal",
    );
  });

  it("still reveals after a restart, from the durable store, without sealing twice", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-juror-restart-"));

    // Pass one, on a real file: the seal is written before the transaction is sent, and the
    // commitment the poster received must be derivable from the salt that landed on disk.
    const a = await harness({ stateDir: dir });
    await a.operator.pass();
    expect(a.commits).toHaveLength(1);
    const onDisk = JSON.parse(await readFile(path.join(dir, "seat-state.json"), "utf8")) as {
      sealed: Record<string, { salt: Hex }>;
    };
    const saltFromDisk = onDisk.sealed["7"]!.salt;
    expect(a.commits[0]!.commit).toBe(Crucible.commit(7n, true, saltFromDisk));

    // The process dies. Everything in memory is gone; the file is all that survives.
    const f = await harness({ stateDir: dir });
    expect(await f.state.pending()).toHaveLength(1);
    expect(f.commits).toEqual([]);

    // Peers have filled the committee since the crash. The commitment pass one posted is still on
    // the chain — a new harness models a new process, not a chain that forgot the transaction —
    // so the restarted seat must see both the peer seals and its own commitment word.
    f.setView(7, { seatCommit: a.commits[0]!.commit, committed: [SEAT.toLowerCase(), PEER.toLowerCase()] });
    await f.operator.pass();

    expect(f.reveals).toHaveLength(1);
    expect(f.reveals[0]!.breakWins).toBe(true);
    // The reveal used the salt from disk, not a fresh random draw — which is the only reason the
    // contract's `keccak256(abi.encodePacked(id, breakWins, salt))` comparison can match.
    expect(f.reveals[0]!.salt).toBe(saltFromDisk);
    // And the restarted seat did not try to post its commitment a second time.
    expect(f.commits).toEqual([]);
  });

  it("does not seal twice when it already holds a seal", async () => {
    const f = await harness();
    await f.operator.pass();
    await f.operator.pass();
    await f.operator.pass();

    expect(f.commits).toHaveLength(1);
    // Skipped from local state before any chain read: a seat that re-seals pays a revert, and a
    // seat that re-reads a trial it already decided pays the node for nothing.
    expect(f.verified).toEqual([7]);
  });

  it("forfeits a closed window without ever running the suite", async () => {
    const f = await harness();
    f.now = OPENED_AT + CONSTANTS.commitWindowSec; // the contract's own boundary: `>=` reverts

    const result = await f.operator.pass();

    expect(f.verified).toEqual([]);
    expect(f.commits).toEqual([]);
    expect(result.counts.forfeit).toBe(1);
    // And it stops asking: the forfeit is durable, so the next pass costs this trial nothing.
    const reads = f.disputeReads;
    await f.operator.pass();
    expect(f.disputeReads).toBe(reads);
    expect(await (await f.state.forfeit(7))?.reason).toContain("the commit window closed");
  });

  it("holds when the window is open but too short to finish a re-run", async () => {
    const f = await harness();
    f.now = OPENED_AT + CONSTANTS.commitWindowSec - CONSTANTS.marginSec;

    await f.operator.pass();

    expect(f.verified).toEqual([]);
    expect(f.commits).toEqual([]);
    expect(await f.state.forfeit(7)).toBeNull();
  });

  it("forfeits when the window closes while the suite is running", async () => {
    const f = await harness();
    // The gate opens on a window still in reach, and the chain clock moves during the container
    // run — which is the slowest thing the pass does, by three orders of magnitude.
    // `windowStillOpen` is the only thing standing between a seat and a transaction that can
    // only revert `CommitClosed`. Advancing the clock from inside the verifier is the only way
    // to exercise that ordering at all.
    const startedAt = f.now;
    f.setVerdict(() => {
      f.now = startedAt + CONSTANTS.commitWindowSec + 1;
      return report();
    });

    const result = await f.operator.pass();
    expect(f.verified).toEqual([7]);
    expect(f.commits).toEqual([]);
    expect(result.counts.forfeit).toBe(1);
    expect((await f.state.forfeit(7))?.reason).toContain("closed while the suite was running");
  });

  it("collects a trial it cannot assemble facts for, rather than voting or throwing", async () => {
    // No agent assigned, or `runHash` still zero: the break arrived before any claim, so there
    // are no bytes to re-execute. `facts.ts` refuses, the pass records the error, and no
    // commitment is cast — which is the abstention rule reached from a different direction.
    const f = await harness();
    const operator = createOperator({
      seat: SEAT,
      constants: CONSTANTS,
      chain: { chainNow: async () => f.now, disputeView: async () => view(7) },
      index: { candidates: () => [7], votes: () => ({ committed: [], revealed: [] }) },
      judge: {
        facts: async () => {
          throw new Error("trial 7 has no run to verify (agentId 0, runHash 0x0000)");
        },
        verify: async () => report(),
      },
      cast: f.cast,
      state: f.state,
      reverifyMs: 900_000,
      wallNow: () => f.wall,
      log: (line) => f.logs.push(line),
    });

    const result = await operator.pass();
    expect(result.counts.error).toBe(1);
    expect(result.counts.commit).toBe(0);
    expect(f.commits).toEqual([]);
  });

  it("keeps going when one trial throws, and still votes on the next", async () => {
    const f = await harness();
    const operator = createOperator({
      seat: SEAT,
      constants: CONSTANTS,
      chain: {
        chainNow: async () => f.now,
        disputeView: async (id) => {
          if (id === 8) throw new Error("node returned nothing for 8");
          return view(9);
        },
      },
      index: { candidates: () => [8, 9], votes: () => ({ committed: [], revealed: [] }) },
      judge: {
        facts: async (id) => ({ trialId: id, agentId: 1, runHash: RUN_HASH, chainId: 31_337, verifyingContract: SEAT, runner: PEER2, sigDeadline: 1n }),
        verify: async () => report({ verdict: "agent-wins" }),
      },
      cast: f.cast,
      state: f.state,
      reverifyMs: 900_000,
      wallNow: () => f.wall,
      log: (line) => f.logs.push(line),
    });

    const result = await operator.pass();
    expect(result.counts.error).toBe(1);
    expect(f.commits).toHaveLength(1);
    expect(f.commits[0]!.trialId).toBe(9);
  });

  it("seals an agent-wins verdict as false", async () => {
    const f = await harness({ initial: report({ verdict: "agent-wins", reason: "the pinned suite reproduces the claim" }) });
    await f.operator.pass();

    const sealed = await f.state.get(7);
    expect(sealed?.breakWins).toBe(false);
    expect(f.commits[0]!.commit).toBe(Crucible.commit(7n, false, sealed!.salt));
  });

  it("drops a seal the chain says was never committed", async () => {
    // The salt was written, the transaction never landed, and the process moved on. The seal is
    // now junk: revealing it reverts `CommitMismatch`, and keeping it means the loop tries to.
    const f = await harness();
    await f.state.put({ trialId: 7, breakWins: true, salt: `0x${"11".repeat(32)}`, commit: HASH, sealedAt: 1 });
    f.setView(7, { seatCommit: NO_COMMIT });

    const result = await f.operator.pass();

    expect(result.counts.drop).toBe(1);
    expect(await f.state.get(7)).toBeNull();
    expect(f.reveals).toEqual([]);
  });

  it("records a lockout and stops when a commitment exists with no salt", async () => {
    // Finding 2's destroyed vote, made visible: the seat cannot open it and cannot replace it.
    const f = await harness();
    f.setView(7, { seatCommit: `0x${"bb".repeat(32)}` });

    const first = await f.operator.pass();
    expect(first.counts.forfeit).toBe(1);
    expect(f.commits).toEqual([]);

    const reads = f.disputeReads;
    await f.operator.pass();
    expect(f.disputeReads).toBe(reads);
    expect(f.logs.join("\n")).toContain("no stored salt");
  });

  it("re-verifies an abstention only after the backoff, and clears the record when it can decide", async () => {
    const f = await harness({
      initial: report({ verdict: "abstain", phase: "abstain", reason: "the artifact was never published" }),
    });
    await f.operator.pass();
    expect(f.verified).toEqual([7]);

    f.now += 10;
    f.wall += 60_000; // inside the backoff: the suite is not worth fifteen minutes again yet
    await f.operator.pass();
    expect(f.verified).toHaveLength(1);

    // The disclosure arrives — on the VPS this is the pin running after the seat started.
    f.wall += 900_000;
    f.setVerdict(report({ verdict: "break-wins" }));
    await f.operator.pass();

    expect(f.verified).toHaveLength(2);
    expect(f.commits).toHaveLength(1);
    expect(await f.state.abstention(7)).toBeNull();
  });

  it("never prints a salt in a log line or a pass report", async () => {
    const f = await harness();
    const first = await f.operator.pass();
    const salt = (await f.state.get(7))!.salt;
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);

    f.setView(7, { committed: [SEAT.toLowerCase(), PEER.toLowerCase()] });
    const second = await f.operator.pass();
    expect(f.reveals).toHaveLength(1);

    // Checked against the value rather than the word: "salt" appears legitimately in a hold
    // reason ("the salt is not in the store"), and the secret is the 32 bytes, not the noun.
    // A reveal's own `breakWins` is public the moment it lands, so it is fine to print; the salt
    // printed here would let anyone pre-open the seat's next commitment.
    const printed = [...f.logs, JSON.stringify(first), JSON.stringify(second)].join("\n");
    expect(printed).not.toContain(salt);
  });
});
