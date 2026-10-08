import { Crucible, TRIALS_ABI, selfSchedulingLoop, type LoopHandle } from "@crucible/smith";
import type { ReadModel } from "@crucible/indexer";
import type { WalletClient } from "viem";
import {
  DEFAULT_CONSTANTS,
  decideAll,
  notifications,
  notifyAll,
  type FinalizeDecision,
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
 */

export interface WardenDeps {
  crucible: Crucible;
  wallet: WalletClient;
  notifier?: Notifier;
  constants?: WardenConstants;
  onLog?: (line: string) => void;
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

    for (const decision of decisions) {
      try {
        const txHash =
          decision.action === "finalize"
            ? await this.deps.crucible.finalize(this.deps.wallet, BigInt(decision.trialId))
            : await this.reclaim(BigInt(decision.trialId));
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
    this.loop = selfSchedulingLoop(() => this.sweep(getModel(), Math.floor(Date.now() / 1000)), {
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

/** Webhook notifier for the Warden pings in /settings. */
export function webhookNotifier(url: string, fetchImpl = fetch): Notifier {
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
