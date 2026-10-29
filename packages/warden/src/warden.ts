import { Crucible, TRIALS_ABI, selfSchedulingLoop, type LoopHandle } from "@crucible/smith";
import type { ReadModel } from "@crucible/indexer";
import type { WalletClient } from "viem";
import {
  DEFAULT_CONSTANTS,
  decideAll,
  notifications,
  notifyAll,
  type FinalizeDecision,
  type Message,
  type Notifier,
  type WardenConstants,
} from "./policy.js";

/**
 * The Warden's chain half.
 *
 * Every action is idempotent by construction: `finalize` and `reclaimExpired` both
 * revert if the trial already settled, so a retried tick is harmless rather than
 * double-paying. Errors are collected per trial instead of aborting the sweep —
 * one bad trial must not stop the others from settling.
 *
 * The keeper's batch surface: `finalize`-decided trials are settled through
 * `CrucibleTrials.settleBatch` (gate 402) so N verified escrows move in ONE tx rather
 * than N txs. The contract skips entries it already settled, but a trial that is not
 * settleable aborts the batch — its revert is the escrow's idempotency guarantee and is not
 * the warden's to swallow. When that happens the sweep retries each trial on its own, which
 * is where per-trial error isolation belongs.
 */

export interface WardenDeps {
  crucible: Crucible;
  wallet: WalletClient;
  notifier?: Notifier;
  constants?: WardenConstants;
  onLog?: (line: string) => void;
  /**
   * The clock every window is measured against, and it must be the CHAIN does.
   *
   * The demo chain is warpable — that is the point of a demo — so a sweep that compared a window
   * deadline against `Date.now()` would sit on its hands for the length of the warp. `start()` used
   * the host clock unconditionally, which meant the only correct caller was one that ignored
   * `start()` entirely and drove `sweep` itself, as the keeper does; every other embedder inherited
   * the bug. The seam is required rather than defaulted so the wall clock is unreachable from here.
   */
  now: () => Promise<number>;
}

export interface SweepResult {
  now: number;
  acted: { decision: FinalizeDecision; txHash: string | null; error: string | null }[];
  notified: number;
}

export class Warden {
  private loop: LoopHandle | null = null;

  constructor(private readonly deps: WardenDeps) {}

  /** One pass over the read model. */
  async sweep(model: ReadModel, nowSeconds: number): Promise<SweepResult> {
    const decisions = decideAll(model, nowSeconds, this.deps.constants ?? DEFAULT_CONSTANTS);
    const acted: SweepResult["acted"] = [];

    // Group the decided actions into batches: consecutive finalize decisions share one
    // settleBatch tx; reclaims stay one-per-trial (reclaimExpired is not on the batch path).
    const finalizeDecisions: FinalizeDecision[] = [];
    const reclaimDecisions: FinalizeDecision[] = [];
    for (const decision of decisions) {
      if (decision.action === "finalize") finalizeDecisions.push(decision);
      else if (decision.action === "reclaim") reclaimDecisions.push(decision);
    }

    if (finalizeDecisions.length > 0) {
      const trialIds = finalizeDecisions.map((d) => BigInt(d.trialId));
      let batchTxHash: `0x${string}` | null = null;
      try {
        batchTxHash = await this.deps.crucible.settleBatch(this.deps.wallet, trialIds);
      } catch (err) {
        // The batch aborts when the chain says an entry is not settleable. That is the
        // idempotency revert, not an outage — and isolation is the warden's job, so the sweep
        // falls back to one finalize per trial: a stale decision costs one tx, not the batch.
        const reason = (err as Error).message;
        this.log(`settleBatch of ${trialIds.length} refused (${reason}); settling per trial`);
        for (const decision of finalizeDecisions) {
          try {
            const txHash = await this.deps.crucible.finalize(this.deps.wallet, BigInt(decision.trialId));
            acted.push({ decision, txHash, error: null });
            this.log(`${decision.action} trial ${decision.trialId} (${decision.reason}) → ${txHash}`);
          } catch (perTrial) {
            acted.push({ decision, txHash: null, error: (perTrial as Error).message });
            this.log(`skip trial ${decision.trialId}: ${(perTrial as Error).message}`);
          }
        }
      }

      if (batchTxHash) {
        // One tx settled the whole batch. The contract skipped entries it had already settled,
        // so a decision that was stale cost nothing and paid nothing.
        for (const decision of finalizeDecisions) {
          acted.push({ decision, txHash: batchTxHash, error: null });
          this.log(
            `${decision.action} trial ${decision.trialId} (${decision.reason}) → ${batchTxHash}`,
          );
        }
      }
    }

    for (const decision of reclaimDecisions) {
      try {
        const txHash = await this.reclaim(BigInt(decision.trialId));
        acted.push({ decision, txHash, error: null });
        this.log(
          `${decision.action} trial ${decision.trialId} (${decision.reason}) → ${txHash}`,
        );
      } catch (err) {
        // Expected in normal operation: someone else finalized first, or the
        // indexer is ahead of the chain head.
        acted.push({ decision, txHash: null, error: (err as Error).message });
        this.log(`skip trial ${decision.trialId}: ${(err as Error).message}`);
      }
    }

    let notified = 0;
    if (this.deps.notifier) {
      const ns = notifications(model, nowSeconds);
      await notifyAll(this.deps.notifier, ns);
      notified = ns.length;
    }

    return { now: nowSeconds, acted, notified };
  }

  /**
   * reclaimExpired lives on the contract but not on the Crucible wrapper, since
   * only the sponsor uses it and the Warden acts for the sponsor's benefit.
   */
  private async reclaim(trialId: bigint): Promise<`0x${string}`> {
    return this.deps.wallet.writeContract({
      address: this.deps.crucible.address,
      abi: TRIALS_ABI,
      functionName: "reclaimExpired",
      args: [trialId],
      chain: this.deps.crucible.config.chain,
      account: this.deps.wallet.account!,
    });
  }

  /**
   * Sweep on an interval, one pass at a time. Idempotent: calling `start` twice does nothing.
   *
   * `setInterval` fired on the wall clock whether or not the previous pass had returned, so a
   * sweep slower than `everySec` ran a second one alongside it over the same read model and the
   * same nonces. Each pass now waits for the one before it, on the same first-pass delay the
   * timer had.
   */
  start(getModel: () => ReadModel, everySec = 60): void {
    if (this.loop) return;
    this.loop = selfSchedulingLoop(async () => this.sweep(getModel(), await this.deps.now()), {
      intervalMs: everySec * 1000,
      runImmediately: false,
      // A library's own timer must not be what holds the host process open; the interval this
      // replaces was unref'd for exactly that reason, and the parity is worth keeping.
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }),
      onError: (err) => this.log(`sweep failed: ${(err as Error).message}`),
    });
    this.loop.start();
  }

  /** Stops scheduling passes. The one already in flight finishes; nothing queues behind it. */
  stop(): void {
    const loop = this.loop;
    if (!loop) return;
    this.loop = null;
    loop.stop();
  }

  private log(line: string): void {
    this.deps.onLog?.(line);
  }
}

/**
 * The webhook channel.
 *
 * The transport is a message, so the parameter is the message: the warden's own
 * notifications are trial events, and the API sends sponsorship applications
 * down the same channel. One notifier, one URL, one place where a delivery
 * failure is caught - rather than a second webhook implementation beside this one.
 */
export function webhookNotifier<T extends Message>(url: string, fetchImpl = fetch): Notifier<T> {
  return {
    async send(n) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: n.message }),
      });
      if (!res.ok) throw new Error(`notifier responded ${res.status}`);
    },
  };
}
