import {
  CircuitBreaker,
  Flags,
  Killed,
  envKillSwitches,
  selfSchedulingLoop,
  type BreakerStatus,
  type LoopHandle,
} from "@crucible/smith";

/**
 * The keeper's acting hop: the clock it decides against, the sweeps it sends, and the two
 * guards that belong between them.
 *
 * It lives here rather than inline in `main.ts` because both guards are behaviour an operator
 * depends on and nothing in `main.ts` can be imported without a chain, a key and a listening
 * socket. `main.ts` supplies the real dependencies; this is the wiring they go through.
 */

/** The switch an operator pulls to stop this keeper sending anything. No deploy, no restart. */
export const SWEEP_FLAG = "keeper.sweep";

/**
 * Hoisted to `@crucible/smith` when the seat operator needed the same switch semantics — kept
 * re-exported here so `main.ts`, the keeper's own tests and every existing import specifier
 * keep pointing at the one implementation rather than a copy.
 */
export { envKillSwitches };

export interface SweepLoopDeps {
  intervalMs: number;
  /** The chain's clock in seconds. Never `Date.now()`: the demo chain is warpable. */
  chainNow: () => Promise<number>;
  /** The thing that moves on chain — what the kill switch refuses and the breaker guards. */
  act: (nowSeconds: number) => Promise<{ acted: readonly unknown[] }>;
  flags: Flags;
  breaker: CircuitBreaker;
  onLog: (line: string) => void;
  /**
   * The kill-switch key this loop answers to. Defaults to the legacy escrow's sweep, because
   * that is the only loop this file used to own; the arena crank passes `keeper.arena` so an
   * operator can stop one loop without stopping the other.
   */
  flag?: string;
}

export interface SweepStatus {
  lastSweepAt: number | null;
  lastSweepActed: number;
  killed: boolean;
  breaker: BreakerStatus;
}

export interface SweepLoop {
  readonly handle: LoopHandle;
  /** One pass, exactly what the loop runs on each tick. */
  sweep(): Promise<void>;
  status(): SweepStatus;
}

export function createSweepLoop(deps: SweepLoopDeps): SweepLoop {
  let lastSweepAt: number | null = null;
  let lastSweepActed = 0;
  let killed = false;

  async function sweep(): Promise<void> {
    try {
      // The kill switch sits *outside* the breaker on purpose: declining to act on an
      // operator's order is not a dependency failure, and counting it would trip the breaker
      // on a deliberate stop and make the switch look like an outage.
      await deps.flags.require(deps.flag ?? SWEEP_FLAG, () =>
        // The breaker covers the whole hop, clock read included. The RPC is the thing that
        // goes away, and a keeper that read the block first would keep hammering a dead node
        // forever while the breaker stayed spotless.
        deps.breaker.exec(async () => {
          const result = await deps.act(await deps.chainNow());
          lastSweepAt = Date.now();
          lastSweepActed = result.acted.length;
          killed = false;
          if (result.acted.length > 0) deps.onLog(`acted on ${result.acted.length} trial(s)`);
        }),
      );
    } catch (err) {
      if (!(err instanceof Killed)) throw err;
      // A killed pass is still a kept appointment. `lastSweepAt` has to move or the compose
      // probe starts failing and restarts the keeper out from under the switch — which is how
      // a kill switch becomes a reboot loop instead of a halt.
      lastSweepAt = Date.now();
      lastSweepActed = 0;
      killed = true;
      deps.onLog(`sweep held: "${err.flag}" is on`);
    }
  }

  const handle = selfSchedulingLoop(sweep, {
    intervalMs: deps.intervalMs,
    // The host primes the first pass itself before it starts listening, and a timer never ran
    // one on the dot; this keeps that cadence without the overlap a wall clock allows.
    runImmediately: false,
    onError: (err) => deps.onLog(`sweep failed: ${(err as Error).message}`),
  });

  return {
    handle,
    sweep,
    status: () => ({
      lastSweepAt,
      lastSweepActed,
      killed,
      breaker: deps.breaker.status(),
    }),
  };
}
