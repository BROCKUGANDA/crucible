import { Crucible } from "@crucible/smith";
import type { Hex } from "viem";
import type { SaltStore, SealedVote } from "./state.js";
import type { VotePoster } from "./chain.js";

/**
 * Seal a verdict, then open it — with the salt on disk before the transaction leaves.
 *
 * GAP(`packages/argus/src/seat.ts`): this is `ArgusSeat`'s job, and the shape it needs is
 * being rewritten in the parent checkout right now (an injected durable salt store instead of
 * the `private pending = new Map()` that loses a seat's vote on a restart). Two things about
 * the current class make it unusable as the caller's dependency, and the second is the reason
 * this file exists rather than a one-line adapter:
 *
 *   1. `randomSalt()` runs inside `commit()`, so no caller can supply or persist a salt
 *      before the transaction is sent. `ArgusSeat.commit` stores it in the Map *after*
 *      `commitVote` returns, which is the failure ordering `state.ts` documents: a process that
 *      dies mid-transaction has a commitment on chain and no salt anywhere, and
 *      `commitVote`'s `AlreadyCommitted` guard (`CrucibleTrials.sol:559`) means the seat can
 *      never act on that trial again.
 *   2. `reveal()` reads that same Map, so a restarted seat cannot open its own commit at all.
 *
 * Once the rewrite lands, `ArgusSeat` should be constructed with the `SaltStore` this takes,
 * and the two methods below become calls to it. Everything else in the service — the gates in
 * `policy.ts`, the loop in `operator.ts` — already talks to a `SaltStore` and a `VotePoster`
 * and does not care which class ends up holding them.
 *
 * The salt never leaves this file except into `revealVote`'s arguments. It is not logged, not
 * returned to `/health`, and not included in any error message.
 */

export interface SeatCast {
  /** True when this seat holds a seal for the trial — the restart path's first question. */
  holds(trialId: number): Promise<boolean>;
  /** Persist the salt, then post the commitment. Returns the transaction hash. */
  seal(trialId: number, breakWins: boolean): Promise<Hex>;
  /** Post the reveal for a seal already held, then forget the salt. Returns the transaction hash. */
  unseal(trialId: number): Promise<Hex>;
  /** Forget a seal that can never be opened (dispute settled, or a commitment that never landed). */
  discard(trialId: number): Promise<void>;
}

export class DurableSeat implements SeatCast {
  constructor(
    private readonly deps: {
      poster: VotePoster;
      state: SaltStore;
      /** only used for the log line a caller prints; the key itself is never touched here */
      seat: string;
    },
  ) {}

  async holds(trialId: number): Promise<boolean> {
    return (await this.deps.state.get(trialId)) !== null;
  }

  async seal(trialId: number, breakWins: boolean): Promise<Hex> {
    // Idempotent by construction, the way the keeper's `finalize` is: a seal already held is
    // re-posted with the SAME commitment rather than generating a fresh salt. A second salt
    // would mean a second commitment, which reverts — and reverting is the expensive way to
    // discover the first one landed.
    const existing = await this.deps.state.get(trialId);
    const vote: SealedVote =
      existing ??
      (() => {
        const salt = randomSalt();
        return {
          trialId,
          breakWins,
          salt,
          commit: Crucible.commit(BigInt(trialId), breakWins, salt),
          sealedAt: Date.now(),
        };
      })();

    if (!existing) await this.deps.state.put(vote);

    // If the transaction below reverts because the seat already sealed on chain, the stored
    // salt is harmless: `gateReveal` compares it against `disputeVote` and drops it when the
    // chain says there is no matching commitment. No cleanup is needed on the failure path.
    return this.deps.poster.commitVote(trialId, vote.commit);
  }

  async unseal(trialId: number): Promise<Hex> {
    const vote = await this.deps.state.get(trialId);
    if (!vote) {
      // Named without the salt it is missing. This is a bug in a caller, not an operational
      // condition — the gates never reach it — so it throws rather than reverting on chain.
      throw new Error(`seat ${this.deps.seat} has no stored seal for trial ${trialId}`);
    }
    // The salt OUTLIVES the send, and is dropped only when the chain says the reveal is on it.
    //
    // `writeContract` resolves with a transaction hash — the node's acceptance, not a block. Deleting
    // here on the strength of that hash would reproduce, in the one place designed to prevent it, the
    // destroyed vote `state.ts` exists to avoid: broadcast, restart before it mines (the health
    // probe, an OOM, a `compose up`), and the seat holds neither a commitment the chain will accept
    // again (`AlreadyRevealed`/`AlreadyCommitted`) nor the salt that opens what it did send.
    //
    // So the next pass decides. If the reveal mined, `disputeVote` reads `revealed` and `gateReveal`
    // returns `drop`, which is where the record is finally discarded. If it did not mine, the next
    // pass simply sends it again. The one wasteful case is a reveal that mined while nobody was
    // looking: the retry reverts `AlreadyRevealed`, the pass records the error, and the pass after
    // reads the chain and drops it. A seat that guesses from an error string would be reading meaning
    // out of viem's wording rather than out of the contract.
    return this.deps.poster.revealVote(trialId, vote.breakWins, vote.salt);
  }

  async discard(trialId: number): Promise<void> {
    await this.deps.state.remove(trialId);
  }
}

/** 32 bytes from the platform CSPRNG, in the `bytes32` shape `commitVote` expects. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}
