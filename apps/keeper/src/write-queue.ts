/**
 * One writer for the keeper's account.
 *
 * The sweep loop and the arena crank share one funded account on independent
 * timers. Without a queue, both loops can be inside a `writeContract` at the
 * same moment; the node's pending-nonce assignment then hands them the same
 * nonce and one of the two transactions replaces or fails. The failures are
 * safe (the contract's status guards refuse a second settle), but they burn
 * gas and fill the trace with errors that look like outages.
 *
 * This queue is the lock: every acting pass runs inside `run`, so sends are
 * serialized process-wide. Pair it with viem's nonce manager on the shared
 * wallet client — the queue stops overlap in time, the manager keeps the
 * nonce sequence explicit even if a future caller sends outside a pass.
 */

export interface WriteQueue {
  /** Run `fn` alone; queued callers run in arrival order. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** How many callers are waiting (excluding the one running). */
  depth(): number;
}

export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      waiting += 1;
      const result = tail.then(() => {
        waiting -= 1;
        return fn();
      });
      // The chain must survive a rejection: the next caller runs whether or
      // not this one threw, while the caller still sees its own rejection.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    depth(): number {
      return waiting;
    },
  };
}
