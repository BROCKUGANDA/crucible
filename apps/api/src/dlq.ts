/**
 * The dead-letter queue.
 *
 * Background work in this process fails in three ways that used to vanish: a sync tick
 * that cannot advance, an alloy read that came back null, an SSE frame that a dead
 * client refused. Each was logged to stdout at best. A bounded ring keeps the most
 * recent failures queryable — `/health` reports the count and the last entry, so an
 * outage is something an operator sees rather than something a log rotation eats.
 *
 * Bounded by design: a DLQ that grows without limit is a second outage wearing the
 * first one's clothes. One hundred entries of the *newest* failures is the forensics
 * that matters; the full history belongs to whatever ships logs off-box.
 */

export interface DeadLetter {
  /** wall-clock ms */
  at: number;
  /** which subsystem failed: scribe.sync, scribe.stall, alloy.read, sse */
  kind: string;
  detail: string;
}

const CAP = 100;
const entries: DeadLetter[] = [];

/**
 * The detail, as a string, always.
 *
 * The queue's job is to report a failure, so it must not be the thing that fails.
 * `detail.slice(0, 300)` threw a `TypeError` when the detail was not a string — and the
 * detail was not a string exactly when the failure was already strange: a caller that did
 * `(err as Error).message` on a non-`Error` throw produced `undefined`. That `TypeError` was
 * raised INSIDE the catch block that was handling the original failure, so it escaped the
 * handler entirely.
 *
 * In the indexer that was fatal: the throw left `watch()`'s promise rejected, nothing awaited
 * it, and Node killed the process. A malformed throw took the whole indexer with it — while
 * the thing being reported was a malformed throw.
 */
function text(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail === null || detail === undefined) return String(detail);
  if (detail instanceof Error) return detail.message;
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    // A value that cannot be serialised is still a value worth naming.
    return Object.prototype.toString.call(detail);
  }
}

export const dlq = {
  push(kind: string, detail: string): void {
    entries.push({ at: Date.now(), kind, detail: text(detail).slice(0, 300) });
    if (entries.length > CAP) entries.shift();
  },

  /** The shape /health reports: enough to alert on, small enough to poll. */
  summary(): { size: number; lastAt: number | null; lastKind: string | null; lastDetail: string | null } {
    const last = entries[entries.length - 1] ?? null;
    return {
      size: entries.length,
      lastAt: last?.at ?? null,
      lastKind: last?.kind ?? null,
      lastDetail: last?.detail ?? null,
    };
  },

  /** Test seam. */
  clear(): void {
    entries.length = 0;
  },
};
