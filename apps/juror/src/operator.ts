import type { Address, Hex } from "viem";
import type { RunFacts, VerifyReport } from "@crucible/argus";
import type { SeatCast } from "./cast.js";
import {
  gateCommit,
  gateReveal,
  windowStillOpen,
  ballotFor,
  type DisputeView,
  type SeatConstants,
} from "./policy.js";
import type { VoteState } from "./state.js";

/**
 * The seat operator's pass: one sweep over the disputes this seat could still act on.
 *
 * The shape is `packages/warden/src/warden.ts`'s `sweep`, for the same reason — one pass over
 * a read model, one action at a time, and an error on one trial never stops the others. That
 * last property is not cosmetic here: a pass that threw on trial 7 would leave trials 8 onward
 * unvoted, and a seat that misses the commit window cannot vote afterwards at all. A broken
 * dispute must cost one vote, not the queue.
 *
 * Reveals go first because they are cheap and time-sensitive in the opposite direction: a
 * sealed verdict waits only for its peers to fill (reveals are not time-gated), while a fresh
 * verification can take a container run. Doing the slow work first would make the cheap half
 * of the job wait behind it every pass.
 */

/** The chain reads a pass needs. Production is `CrucibleChain`; tests are an object literal. */
export interface ChainPort {
  chainNow(): Promise<number>;
  disputeView(trialId: number, votes: { committed: string[]; revealed: string[] }): Promise<DisputeView>;
}

/** The index projection: which trials look challenged, and which seats the logs say have sealed. */
export interface IndexPort {
  candidates(): number[];
  votes(trialId: number): { committed: string[]; revealed: string[] };
}

/**
 * Assembles the facts and runs the deterministic verifier over them.
 *
 * The port speaks `RunFacts` rather than the chain-readable subset because the subset is
 * `facts.ts`'s provenance argument, not this file's business: by the time a verdict is being
 * formed, the caller of the verifier has to hand it the same type the verifier declares.
 */
export interface JudgePort {
  facts(trialId: number): Promise<RunFacts>;
  verify(facts: RunFacts): Promise<VerifyReport>;
}

export type ActionKind = "commit" | "reveal" | "abstain" | "forfeit" | "drop" | "hold" | "error";

export interface PassAction {
  trialId: number;
  action: ActionKind;
  /** the reason the rule produced, or the error message — never a salt, never a key */
  detail: string;
  txHash: Hex | null;
}

export interface PassReport {
  /** the chain clock the pass decided against */
  now: number;
  considered: number;
  actions: PassAction[];
  counts: Record<ActionKind, number>;
}

export interface OperatorDeps {
  seat: Address;
  constants: SeatConstants;
  chain: ChainPort;
  index: IndexPort;
  judge: JudgePort;
  cast: SeatCast;
  state: VoteState;
  /** how long a recorded abstention sits before its suite is re-run; see `reverifyAt` */
  reverifyMs: number;
  log(line: string): void;
  /**
   * Wall clock, in ms, for the re-verification backoff only.
   *
   * Every *deadline* in this file is measured against `chain.chainNow()`, because the demo
   * chain is warpable and a seat that compared window deadlines to the host clock would sit on
   * its hands for whatever a test warp put between them. A backoff on re-running a container is
   * the opposite kind of wait — it protects the machine, not the protocol — so it is measured
   * in the time the bench actually takes, which is wall time. On a warped chain this simply
   * means a re-run may come earlier or later in chain-seconds; the rules re-check every deadline
   * anyway, so it cannot vote out of turn.
   */
  wallNow(): number;
}

const zeroCounts = (): Record<ActionKind, number> => ({
  commit: 0,
  reveal: 0,
  abstain: 0,
  forfeit: 0,
  drop: 0,
  hold: 0,
  error: 0,
});

export interface JurorOperator {
  pass(): Promise<PassReport>;
}

export function createOperator(deps: OperatorDeps): JurorOperator {
  const empty = zeroCounts;

  async function pass(): Promise<PassReport> {
    const now = await deps.chain.chainNow();
    const actions: PassAction[] = [];
    const counts = empty();
    let considered = 0;

    const record = (trialId: number, action: ActionKind, detail: string, txHash: Hex | null = null): void => {
      counts[action] += 1;
      actions.push({ trialId, action, detail, txHash });
      // `hold` is the only outcome that repeats every pass by design (waiting for peers to
      // seal), so it is counted and reported but not printed. Everything else is either an
      // action taken or a decision reached, and an operator reads those in the log.
      if (action !== "hold") deps.log(`trial ${trialId}: ${action} — ${detail}`);
    };

    // ── 1. unseal what is already sealed and can now be opened ───────────────
    for (const seal of await deps.state.pending()) {
      considered += 1;
      try {
        const view = await deps.chain.disputeView(seal.trialId, deps.index.votes(seal.trialId));
        const gate = gateReveal(view, deps.seat, seal, deps.constants);
        switch (gate.act) {
          case "reveal": {
            const tx = await deps.cast.unseal(seal.trialId);
            record(seal.trialId, "reveal", `breakWins=${seal.breakWins} after ${view.committed.length} seals`, tx);
            break;
          }
          case "drop": {
            // The salt is worthless: either the reveal is already on chain (so it is public) or
            // the seal can never be opened. Dropping is what stops the loop re-reading a dead
            // dispute forever.
            await deps.cast.discard(seal.trialId);
            record(seal.trialId, "drop", gate.reason);
            break;
          }
          case "hold":
            record(seal.trialId, "hold", gate.reason);
            break;
        }
      } catch (err) {
        // A failed reveal leaves the seal in place on purpose. If the transaction actually
        // mined, the next pass reads `disputeVote` as revealed and drops it; if it did not, the
        // next pass tries once more. Guessing from the error text would be the alternative,
        // and viem's is not a protocol fact.
        record(seal.trialId, "error", `reveal failed: ${(err as Error).message}`);
      }
    }

    // ── 2. form a verdict for disputes this seat has not sealed ──────────────
    for (const trialId of deps.index.candidates()) {
      considered += 1;
      try {
        // Three questions answered from local state, before any chain read: has this seat
        // already given up on the trial, does it hold a seal (then the loop above owns it), and
        // is it merely waiting out a re-verification backoff.
        const givenUp = await deps.state.forfeit(trialId);
        if (givenUp) continue;
        if (await deps.cast.holds(trialId)) continue;

        const prior = await deps.state.abstention(trialId);
        if (prior && deps.wallNow() - prior.at < deps.reverifyMs) {
          record(
            trialId,
            "hold",
            `abstained ${Math.round((deps.wallNow() - prior.at) / 1000)}s ago (${prior.reason}); ` +
              `the suite is re-run for it in ${Math.ceil((deps.reverifyMs - (deps.wallNow() - prior.at)) / 1000)}s`,
          );
          continue;
        }

        const view = await deps.chain.disputeView(trialId, deps.index.votes(trialId));
        const gate = gateCommit(view, deps.constants, now);
        if (gate.act === "forfeit") {
          await deps.state.recordForfeit({ trialId, reason: gate.reason, at: deps.wallNow() });
          record(trialId, "forfeit", gate.reason);
          continue;
        }
        if (gate.act === "hold") {
          record(trialId, "hold", gate.reason);
          continue;
        }

        // A previous abstention is not a life sentence: the disclosure that was missing may
        // have arrived (on the VPS the pin runs after this service starts, at least once). It
        // does not have to be true any more, so the record is dropped as soon as the seat has
        // something better to say.
        if (prior) await deps.state.clearAbstention(trialId);

        const facts = await deps.judge.facts(trialId);
        const report = await deps.judge.verify(facts);
        const ballot = ballotFor(report);

        if (ballot.vote === "abstain") {
          await deps.state.recordAbstention({
            trialId,
            reason: report.reason,
            phase: report.phase,
            at: deps.wallNow(),
          });
          record(
            trialId,
            "abstain",
            `${report.reason} (stopped in the ${report.phase} phase; no commitment is cast for an abstention)`,
          );
          continue;
        }

        // The window is re-checked immediately before the only irreversible thing this pass
        // does. `gate.act === "verify"` was decided before a container ran, and the container is
        // the slowest thing in the process: trusting that first answer is how a seat posts a
        // commitment that reverts `CommitClosed` and burns the vote anyway.
        const fresh = await deps.chain.disputeView(trialId, deps.index.votes(trialId));
        const freshNow = await deps.chain.chainNow();
        if (!windowStillOpen(fresh, deps.constants, freshNow)) {
          const reason =
            `the commit window closed while the suite was running (decided at ${now}, re-checked at ${freshNow}) ` +
            `on a verdict of ${report.verdict}`;
          await deps.state.recordForfeit({ trialId, reason, at: deps.wallNow() });
          record(trialId, "forfeit", reason);
          continue;
        }

        const tx = await deps.cast.seal(trialId, ballot.breakWins);
        record(
          trialId,
          "commit",
          `breakWins=${ballot.breakWins} because ${report.reason} — ${view.committed.length + 1} seat(s) sealed once this lands`,
          tx,
        );
      } catch (err) {
        record(trialId, "error", `pass failed: ${(err as Error).message}`);
      }
    }

    return { now, considered, actions, counts };
  }

  return { pass };
}
