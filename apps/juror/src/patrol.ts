import { CircuitBreaker, Flags, Killed, selfSchedulingLoop, type BreakerStatus, type LoopHandle } from "@crucible/smith";
import type { PassReport } from "./operator.js";

/**
 * The scheduling hop: the kill switch, the breaker, and the freshness the probe polls.
 *
 * This is `apps/keeper/src/sweep-loop.ts`'s shape, and it is the second copy of that shape in
 * the repo. The loop primitive is *not* duplicated — both call `selfSchedulingLoop`, which is
 * why a slow pass cannot start a second one on top of it, and a seat doing that would post the
 * same commitment twice and read the same nonces twice. What is duplicated is the twelve lines
 * of wiring around the operator's own flag name and status payload, because an app is not a
 * library here and importing across apps would mean one service depending on another's build
 * output. If a third long-running service appears, this and the keeper's belong together in
 * `@crucible/smith` beside `Flags`.
 */

/** The switch an operator pulls to stop this seat voting. No deploy, no restart. */
export const VOTE_FLAG = "juror.vote";

export interface PatrolDeps {
  intervalMs: number;
  flags: Flags;
  breaker: CircuitBreaker;
  /** One pass of the operator — the thing the switch refuses and the breaker guards. */
  pass(): Promise<PassReport>;
  onLog: (line: string) => void;
}

export interface PatrolStatus {
  lastPassAt: number | null;
  lastPassConsidered: number;
  /** actions that changed something on chain, so `/health` can distinguish idle from busy */
  lastPassActed: number;
  /** the verdicts this seat declined to cast, with how long it has been silent */
  lastPassAbstained: number;
  killed: boolean;
  breaker: BreakerStatus;
}

export interface PatrolLoop {
  readonly handle: LoopHandle;
  pass(): Promise<void>;
  status(): PatrolStatus;
}

export function createPatrolLoop(deps: PatrolDeps): PatrolLoop {
  let lastPassAt: number | null = null;
  let lastPassConsidered = 0;
  let lastPassActed = 0;
  let lastPassAbstained = 0;
  let killed = false;

  async function pass(): Promise<void> {
    try {
      // Switch first, breaker second, in that order and for the keeper's reason: declining to
      // act on an operator's order is not a dependency failure, and counting it would trip the
      // breaker on a deliberate stop — which makes a halt look like an outage in `/health`, and
      // in the log, to whoever is reading it at 3am.
      await deps.flags.require(VOTE_FLAG, () =>
        // The breaker covers the whole hop, clock read and index read included. The RPC is the
        // thing that goes away; a pass that read the block before the breaker would hammer a
        // dead node while the breaker stayed spotless.
        deps.breaker.exec(async () => {
          const result = await deps.pass();
          lastPassAt = Date.now();
          lastPassConsidered = result.considered;
          lastPassActed = result.counts.commit + result.counts.reveal;
          lastPassAbstained = result.counts.abstain;
          killed = false;
          if (lastPassActed > 0) deps.onLog(`cast ${result.counts.commit} seal(s) and ${result.counts.reveal} reveal(s)`);
          if (result.counts.forfeit > 0) deps.onLog(`forfeited ${result.counts.forfeit} trial(s)`);
        }),
      );
    } catch (err) {
      if (!(err instanceof Killed)) throw err;
      // A killed pass still keeps the appointment. `lastPassAt` has to move or the compose probe
      // fails, restarts the seat out from under the switch, and turns a halt into a reboot loop.
      lastPassAt = Date.now();
      lastPassConsidered = 0;
      lastPassActed = 0;
      lastPassAbstained = 0;
      killed = true;
      deps.onLog(`voting held: "${err.flag}" is on (${VOTE_FLAG} is this process's switch)`);
    }
  }

  const handle = selfSchedulingLoop(pass, {
    intervalMs: deps.intervalMs,
    // `main.ts` runs the first pass itself before it starts listening, so the timer's first tick
    // is one interval away rather than an overlap of the boot pass.
    runImmediately: false,
    onError: (err) => deps.onLog(`pass failed: ${(err as Error).message}`),
  });

  return {
    handle,
    pass,
    status: () => ({
      lastPassAt,
      lastPassConsidered,
      lastPassActed,
      lastPassAbstained,
      killed,
      breaker: deps.breaker.status(),
    }),
  };
}
