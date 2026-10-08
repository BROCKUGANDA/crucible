/**
 * A clock the test drives, because every timing primitive in `patterns.ts` takes `now`/`sleep`
 * injection for exactly this reason: a suite that proves cooldowns and poll intervals by
 * spending real seconds is a suite nobody runs.
 */

/** Lets pending promise chains and macrotasks run to exhaustion. */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface Timer {
  readonly at: number;
  readonly id: number;
  readonly resolve: () => void;
}

export class VirtualClock {
  current = 0;
  private timers: Timer[] = [];
  private seq = 0;

  now = (): number => this.current;

  sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.seq += 1;
      this.timers.push({ at: this.current + Math.max(0, ms), id: this.seq, resolve });
    });

  /** Timers waiting to fire — an orphaned sleep from a stopped loop still shows up here. */
  get pending(): number {
    return this.timers.length;
  }

  /**
   * Moves time forward by `deltaMs`, firing every timer due in that span in chronological
   * order and draining the microtask and macrotask queues between each, so anything that woke
   * up can register its next timer. Relative, not absolute: a test that says "wait 5s" should
   * not have to know what time it is.
   */
  async advance(deltaMs: number): Promise<void> {
    const to = this.current + deltaMs;
    // Let whatever is already running park itself before time moves: work suspended on a
    // microtask has no timer yet, and skipping this would jump over the timer it registers.
    await flush();
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= to)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      this.current = Math.max(this.current, next.at);
      next.resolve();
      await flush();
    }
    this.current = Math.max(this.current, to);
    await flush();
  }
}

/** A deferred, for tests that need to decide when the underlying call answers. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const out: Deferred<T> = {
    promise,
    resolve: (value: T) => {
      out.settled = true;
      resolve(value);
    },
    reject: (err: unknown) => {
      out.settled = true;
      reject(err);
    },
    settled: false,
  };
  promise.catch(() => undefined);
  return out;
}

/** Collects unhandled rejections so a test can assert that it produced none. */
export function watchUnhandledRejections(): {
  seen: unknown[];
  stop: () => void;
} {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  return {
    seen,
    stop: () => process.off("unhandledRejection", onRejection),
  };
}
