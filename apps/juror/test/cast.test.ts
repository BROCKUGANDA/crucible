import { describe, expect, it } from "vitest";
import { Crucible } from "@crucible/smith";
import type { Hex } from "viem";
import { DurableSeat, randomSalt } from "../src/cast.js";
import type { VotePoster } from "../src/chain.js";
import { MemoryState, type SaltStore, type SealedVote } from "../src/state.js";

/**
 * The seat's own transaction ordering.
 *
 * One rule decides whether a crash costs a vote, and it is not a rule an integration test can be
 * trusted to catch, because the interesting case is a process that dies at one exact moment. So
 * the order is asserted directly: the store is a recording wrapper, and the trace says what
 * happened before what.
 */

const SEAT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const HASH: Hex = `0x${"ab".repeat(32)}`;

/** A `SaltStore` that logs its own calls into the shared trace. */
function tracingStore(trace: string[]): SaltStore {
  const inner = new MemoryState();
  return {
    async get(trialId) {
      return inner.get(trialId);
    },
    async put(vote: SealedVote) {
      trace.push("state.put");
      return inner.put(vote);
    },
    async remove(trialId) {
      trace.push("state.remove");
      return inner.remove(trialId);
    },
    async all() {
      return inner.all();
    },
  };
}

function harness() {
  const trace: string[] = [];
  const store = tracingStore(trace);
  const commits: { trialId: number; commit: Hex }[] = [];
  const reveals: { trialId: number; breakWins: boolean; salt: Hex }[] = [];
  let failNext = false;

  const poster: VotePoster = {
    commitVote: async (trialId, commit) => {
      trace.push("commitVote");
      if (failNext) throw new Error("AlreadyCommitted");
      commits.push({ trialId, commit });
      return HASH;
    },
    revealVote: async (trialId, breakWins, salt) => {
      trace.push("revealVote");
      if (failNext) throw new Error("CommitMismatch");
      reveals.push({ trialId, breakWins, salt });
      return HASH;
    },
  };

  return {
    trace,
    commits,
    reveals,
    store,
    cast: new DurableSeat({ poster, state: store, seat: SEAT }),
    fail(value: boolean): void {
      failNext = value;
    },
  };
}

describe("DurableSeat.seal", () => {
  it("writes the salt to the store before the transaction is sent", async () => {
    const h = harness();
    await h.cast.seal(7, true);

    // The ordering, in the trace itself. Written first means a crash between the two leaves a
    // salt for a commitment nobody posted — recoverable, the seat just re-verifies and seals.
    // Sent first would leave the opposite: a commitment on chain with no salt anywhere, and
    // `AlreadyCommitted` means that seat can never act on the trial again.
    expect(h.trace).toEqual(["state.put", "commitVote"]);
  });

  it("keeps the seal when the commit reverts, so the next pass can post it again", async () => {
    const h = harness();
    h.fail(true);

    await expect(h.cast.seal(7, true)).rejects.toThrow("AlreadyCommitted");
    expect(h.trace).toEqual(["state.put", "commitVote"]);
    expect(await h.cast.holds(7)).toBe(true);
  });

  it("re-posts the SAME commitment rather than drawing a second salt", async () => {
    const h = harness();
    await h.cast.seal(7, true);
    h.fail(false);
    await h.cast.seal(7, true);

    expect(h.commits).toHaveLength(2);
    expect(h.commits[0]!.commit).toBe(h.commits[1]!.commit);
    // A second salt would mean a different commitment, which is a different vote — and posting
    // it is the revert, not the answer.
    expect(h.trace.filter((t) => t === "state.put")).toHaveLength(1);
  });

  it("seals what the contract will be able to check", async () => {
    const h = harness();
    await h.cast.seal(7, true);

    // The commitment must be `keccak256(abi.encodePacked(uint256 id, bool breakWins, bytes32
    // salt))`. Getting the encoding wrong (decimal text for the id, a 32-byte bool) produces a
    // commitment that never matches on reveal, so the reveal reverts and the vote is destroyed.
    // This asserts against the SDK's own builder, which is the same one the runner uses.
    const posted = h.commits[0]!.commit;
    expect(posted).toMatch(/^0x[0-9a-f]{64}$/);
    expect(posted).toBe(Crucible.commit(7n, true, (await peek(h))!));
  });
});

describe("DurableSeat.unseal", () => {
  it("posts the stored salt and KEEPS it, because a hash is not a block", async () => {
    const h = harness();
    await h.cast.seal(7, true);
    const salt = await peek(h);

    await h.cast.unseal(7);

    expect(h.reveals[0]).toEqual({ trialId: 7, breakWins: true, salt });
    // `state.remove` is deliberately absent. `writeContract` resolves when the node accepts the
    // transaction, not when it is mined, so a seat that deleted the salt here would lose the vote on
    // any death between the send and the block — and `AlreadyCommitted` means the seat cannot replace
    // it. The record is discarded by the pass that reads `revealed` off the chain (via `discard`),
    // which is the only moment the salt is genuinely worthless.
    expect(h.trace).toEqual(["state.put", "commitVote", "revealVote"]);
  });

  it("still holds the salt after a broadcast, so a restart can finish the reveal", async () => {
    // The shape of the crash this whole module exists for: the transaction is out, the process dies
    // before anybody has seen it mined.
    const h = harness();
    await h.cast.seal(7, true);
    const before = await peek(h);
    await h.cast.unseal(7);

    expect(await h.store.get(7)).not.toBeNull();
    expect((await h.store.get(7))!.salt).toBe(before);
    // The next pass, seeing no `revealed` on the chain, sends it again; seeing it, drops the record.
    await h.cast.discard(7);
    expect(await h.store.get(7)).toBeNull();
  });

  it("keeps the salt when the reveal reverts, so the next pass can decide from the chain", async () => {
    // No error-string matching anywhere in the operator, and this is why: if the reveal actually
    // mined, the next pass reads `disputeVote` as revealed and drops the record; if it did not,
    // it tries again. Both need the salt to still be on disk.
    const h = harness();
    await h.cast.seal(7, false);
    h.fail(true);

    await expect(h.cast.unseal(7)).rejects.toThrow("CommitMismatch");
    expect(h.trace).toContain("state.put");
    expect(h.trace).not.toContain("state.remove");
  });

  it("refuses to reveal a trial it never sealed, naming the seat and not a salt", async () => {
    const h = harness();
    let message = "";
    try {
      await h.cast.unseal(99);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(SEAT);
    expect(message).not.toContain(HASH);
    expect(h.reveals).toEqual([]);
  });
});

describe("randomSalt", () => {
  it("is 32 fresh bytes every call", () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

/**
 * The salt the seat is holding, read back through the same store.
 *
 * The store is private inside `DurableSeat`, so this goes through its public question — which is
 * also the shape of the restart path: an operator process only ever learns its own salts from
 * the store, never from the seat object.
 */
async function peek(h: ReturnType<typeof harness>): Promise<Hex | null> {
  const all = await h.store.all();
  return all[0]?.salt ?? null;
}
