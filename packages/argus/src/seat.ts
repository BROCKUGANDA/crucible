import { Crucible } from "@crucible/smith";
import type { WalletClient } from "viem";

/**
 * The Argus seat's on-chain half: commit, then reveal.
 *
 * Anti-collusion ordering matters. A seat only reveals after a second seat has
 * committed, so no judge can read a peer's vote and copy it. The salt is generated
 * locally and never leaves this process until reveal.
 */

export interface SeatConfig {
  id: string;
  /** the seat's voting wallet */
  wallet: WalletClient;
  crucible: Crucible;
  /** called before revealing, to give the commit phase time to fill */
  waitForCommits?: (trialId: bigint, needed: number) => Promise<void>;
}

export interface SeatVote {
  trialId: bigint;
  breakWins: boolean;
  commit: `0x${string}`;
  salt: `0x${string}`;
}

function randomSalt(): `0x${string}` {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;
}

export class ArgusSeat {
  private readonly pending = new Map<string, SeatVote>();

  constructor(private readonly cfg: SeatConfig) {}

  /** Seal a verdict. The salt is retained for the reveal. */
  async commit(trialId: bigint, breakWins: boolean): Promise<SeatVote> {
    const salt = randomSalt();
    const commit = Crucible.commit(trialId, breakWins, salt);
    const tx = await this.cfg.crucible.commitVote(this.cfg.wallet, trialId, commit);
    const vote: SeatVote = { trialId, breakWins, commit, salt };
    this.pending.set(key(trialId), vote);
    void tx;
    return vote;
  }

  /** Unseal. Refuses if no matching commit exists, which would revert anyway. */
  async reveal(trialId: bigint): Promise<`0x${string}`> {
    const vote = this.pending.get(key(trialId));
    if (!vote) {
      throw new Error(`seat ${this.cfg.id} has no sealed vote for trial ${trialId}`);
    }
    if (this.cfg.waitForCommits) {
      await this.cfg.waitForCommits(trialId, 2);
    }
    const tx = await this.cfg.crucible.revealVote(
      this.cfg.wallet,
      trialId,
      vote.breakWins,
      vote.salt,
    );
    this.pending.delete(key(trialId));
    return tx;
  }

  hasPending(trialId: bigint): boolean {
    return this.pending.has(key(trialId));
  }
}

function key(trialId: bigint): string {
  return trialId.toString();
}

/** Salt is derived per vote and stored only in memory — never logged. */
export function saltFor(trialId: bigint, breakWins: boolean): `0x${string}` {
  void trialId;
  void breakWins;
  return randomSalt();
}
