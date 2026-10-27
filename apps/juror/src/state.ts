import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hex } from "viem";

/**
 * The seat's durable memory: which verdicts it sealed and which it declined to judge.
 *
 * The salt is the whole reason this file exists. `ArgusSeat` as written holds it in an
 * in-memory `Map` (`packages/argus/src/seat.ts`'s `private pending`), so a process that dies
 * between `commitVote` and `revealVote` loses the opening of its own commitment — and
 * `commitVote` reverts `AlreadyCommitted` for that seat on that trial forever
 * (`crucible-contracts/contracts/CrucibleTrials.sol:559`). The seat is then mute on that
 * dispute for the rest of the chain's life: it cannot re-seal a different verdict, and it
 * cannot reveal the one it sealed. That is not a crash to recover from, it is a vote destroyed
 * by a crash, and it is the one failure mode a committee cannot route around.
 *
 * Two rules follow from that and both are enforced here rather than trusted:
 *
 *   1. `put()` runs BEFORE the commit transaction is sent. A crash after the write costs a
 *      salt for a commit that never landed — recoverable, the seat just re-verifies and seals
 *      again. A crash before the write, with the commit already on chain, is the destroyed
 *      vote above. The two failure directions are not symmetric, so the write goes first.
 *   2. `remove()` runs only once the reveal is known to be on chain (or the trial is settled).
 *      Deleting early is rule 1's failure mode again.
 *
 * Abstentions are kept in the same file because they are the same kind of fact — a decision
 * this seat made about a specific trial that has to survive a restart — and because the loop
 * needs it to decide whether a suite is worth fifteen more minutes of re-execution.
 *
 * Nothing in this module logs. A `console.log` added here would eventually print a salt.
 */

/** What a stranger can do with a verdict after the fact (ADR-0013). */
export type ReplayabilityClass = "artifact-replayable" | "generation-attested" | "undecided";

/** One sealed verdict: the commitment the chain holds, plus the only thing that opens it. */
export interface SealedVote {
  trialId: number;
  /** the vote `breakWins` encodes — `true` is "the skeptic was right" */
  breakWins: boolean;
  /** SECRET until reveal. Never logged, never returned by `/health`, never in an error. */
  salt: Hex;
  /** `keccak256(abi.encodePacked(trialId, breakWins, salt))` as posted */
  commit: Hex;
/**
   * The verdict's replayability class, recorded at sealing so the claim's kind
   * survives in the seat's durable record rather than only in a log line.
   * Optional because state files written before this was recorded have none.
   */
  replayability?: ReplayabilityClass;
  /** unix ms of the pass that sealed it — bookkeeping for the log line, not a deadline */
  sealedAt: number;
}

/** A trial this seat could not judge, and why. */
export interface Abstention {
  trialId: number;
  /** the report's own reason, verbatim — the honest record is that the seat could not check */
  reason: string;
  /** the phase the verifier stopped in, so an operator can tell "no bytes" from "no bench" */
  phase: VerifyPhase;
  /** unix ms; the loop re-runs the suite for this trial after `reverifyMs` from here */
  at: number;
}

export type VerifyPhase = "deterministic" | "rubric" | "abstain";

/** What `ArgusSeat` is being rewritten to accept, and what the operator injects today. */
export interface SaltStore {
  get(trialId: number): Promise<SealedVote | null>;
  put(vote: SealedVote): Promise<void>;
  remove(trialId: number): Promise<void>;
  all(): Promise<SealedVote[]>;
}

/**
 * A trial this seat will never vote on, and why.
 *
 * Two permanent conditions produce one: the commit window closed while the seat was busy or
 * down, and a commitment that exists on chain with no salt anywhere to open it. Both mean
 * `commitVote` reverts for the rest of the chain's life, so the only correct response is to
 * stop asking — which needs the answer to survive a restart, or the loop starts reading every
 * forfeited dispute again on every pass forever. Recording it is also what makes the lost vote
 * visible to an operator instead of looking like a seat that had nothing to say.
 */
export interface Forfeit {
  trialId: number;
  reason: string;
  at: number;
}

export interface VoteState extends SaltStore {
  abstention(trialId: number): Promise<Abstention | null>;
  recordAbstention(a: Abstention): Promise<void>;
  clearAbstention(trialId: number): Promise<void>;
  forfeit(trialId: number): Promise<Forfeit | null>;
  recordForfeit(f: Forfeit): Promise<void>;
  /** Every trial this seat has an unrevealed commit on. The restart path. */
  pending(): Promise<SealedVote[]>;
}

interface Snapshot {
  version: 1;
  sealed: Record<string, SealedVote>;
  abstained: Record<string, Abstention>;
  givenUp: Record<string, Forfeit>;
}

const EMPTY: Snapshot = { version: 1, sealed: {}, abstained: {}, givenUp: {} };

/**
 * In-memory, for tests and for a single-process run that is allowed to forget.
 *
 * Identical semantics to `FileState` minus the disk, so the operator's decision logic can be
 * driven without a filesystem — and so a test that asserts "restart keeps the salt" is
 * asserting something about `FileState` specifically, not about the loop.
 */
export class MemoryState implements VoteState {
  private readonly sealed = new Map<number, SealedVote>();
  private readonly abstained = new Map<number, Abstention>();
  private readonly givenUp = new Map<number, Forfeit>();

  async get(trialId: number): Promise<SealedVote | null> {
    return this.sealed.get(trialId) ?? null;
  }
  async put(vote: SealedVote): Promise<void> {
    this.sealed.set(vote.trialId, vote);
  }
  async remove(trialId: number): Promise<void> {
    this.sealed.delete(trialId);
  }
  async all(): Promise<SealedVote[]> {
    return [...this.sealed.values()];
  }
  async pending(): Promise<SealedVote[]> {
    return this.all();
  }
  async abstention(trialId: number): Promise<Abstention | null> {
    return this.abstained.get(trialId) ?? null;
  }
  async recordAbstention(a: Abstention): Promise<void> {
    this.abstained.set(a.trialId, a);
  }
  async clearAbstention(trialId: number): Promise<void> {
    this.abstained.delete(trialId);
  }
  async forfeit(trialId: number): Promise<Forfeit | null> {
    return this.givenUp.get(trialId) ?? null;
  }
  async recordForfeit(f: Forfeit): Promise<void> {
    this.givenUp.set(f.trialId, f);
  }
}

/**
 * The durable one. One JSON file, replaced by rename.
 *
 * Write-temp-then-rename is the same rule the Scribe's cursor follows (`scribe.ts`'s
 * `cursorFile`): a process killed mid-write must not leave a half-written file, and here a
 * half-written file is a lost salt. Readers of the old content keep reading the old inode
 * until the rename lands.
 */
export class FileState implements VoteState {
  // All three maps fresh. `{ ...EMPTY, sealed: {}, abstained: {} }` rebound two of them and left
  // `givenUp` pointing at the module constant, so a seat with no state file wrote its forfeits into
  // `EMPTY` itself — and a second seat constructed against a different directory, with no file of
  // its own, would inherit the first one's decisions and skip trials it had never given up on.
  private snapshot: Snapshot = { version: 1, sealed: {}, abstained: {}, givenUp: {} };
  private loaded = false;
  /** Serialises writes: two passes on one process must not interleave a read-modify-write. */
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async open(dir: string): Promise<FileState> {
    const state = new FileState(path.join(dir, "seat-state.json"));
    await mkdir(path.dirname(state.file), { recursive: true });
    state.load();
    return state;
  }

  /**
   * Lazy, and it refuses rather than starting empty.
   *
   * A state file that does not parse is a pile of sealed salts the seat can no longer open.
   * Treating that as "no state yet" would let the loop commit again — and `AlreadyCommitted`
   * means the second commit reverts, so the seat would hammer a guaranteed revert every pass
   * while the first commitment sits there unrevealable. The operator stops and names the file.
   */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    const raw = readFileSyncSafe(this.file);
    try {
      const parsed = JSON.parse(raw) as Partial<Snapshot>;
      this.snapshot = {
        version: 1,
        sealed: parsed.sealed && typeof parsed.sealed === "object" ? parsed.sealed : {},
        abstained: parsed.abstained && typeof parsed.abstained === "object" ? parsed.abstained : {},
        // A state file written before forfeits were tracked simply has no such map; that is an
        // empty set of decisions, not a corrupt file.
        givenUp: parsed.givenUp && typeof parsed.givenUp === "object" ? parsed.givenUp : {},
      };
    } catch (err) {
      throw new Error(
        `juror refusing to start: ${this.file} is not valid JSON (${(err as Error).message}) — it holds this ` +
          "seat's unopened commitments, so it is restored or renamed deliberately, never silently discarded",
      );
    }
    this.harden();
  }

  /** 0600, best effort: the salt is a secret and NTFS permissions are the host's to decide. */
  private harden(): void {
    void chmod(this.file, 0o600).catch(() => undefined);
  }

  private mutate(fn: (s: Snapshot) => void): Promise<void> {
    this.load();
    fn(this.snapshot);
    const json = JSON.stringify(this.snapshot);
    // Chained rather than raced: the write that follows a read-modify-write must see it.
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, this.file);
      this.harden();
    });
    return this.queue;
  }

  async get(trialId: number): Promise<SealedVote | null> {
    this.load();
    return this.snapshot.sealed[String(trialId)] ?? null;
  }

  async put(vote: SealedVote): Promise<void> {
    await this.mutate((s) => {
      s.sealed[String(vote.trialId)] = vote;
    });
  }

  async remove(trialId: number): Promise<void> {
    await this.mutate((s) => {
      delete s.sealed[String(trialId)];
    });
  }

  async all(): Promise<SealedVote[]> {
    this.load();
    return Object.values(this.snapshot.sealed);
  }

  async pending(): Promise<SealedVote[]> {
    return this.all();
  }

  async abstention(trialId: number): Promise<Abstention | null> {
    this.load();
    return this.snapshot.abstained[String(trialId)] ?? null;
  }

  async recordAbstention(a: Abstention): Promise<void> {
    await this.mutate((s) => {
      s.abstained[String(a.trialId)] = a;
    });
  }

  async clearAbstention(trialId: number): Promise<void> {
    await this.mutate((s) => {
      delete s.abstained[String(trialId)];
    });
  }

  async forfeit(trialId: number): Promise<Forfeit | null> {
    this.load();
    return this.snapshot.givenUp[String(trialId)] ?? null;
  }

  async recordForfeit(f: Forfeit): Promise<void> {
    await this.mutate((s) => {
      s.givenUp[String(f.trialId)] = f;
    });
  }
}

function readFileSyncSafe(file: string): string {
  return readFileSync(file, "utf8");
}
