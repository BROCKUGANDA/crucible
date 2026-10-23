/**
 * Bounding what a page draws from a live read model.
 *
 * The board's source is `/snapshot` — the whole index, newest trial first — because the same
 * payload drives the live counters and the SSE refresh. That is the right shape for a demo chain
 * and the wrong shape for an unbounded `for` loop over every row: a long-running chain would have
 * this page render thousands of nodes on every frame the index moves, which is how a site that is
 * working becomes a tab that eats the machine. Paginating the *fetch* would trade the live view for
 * a cursor, so the bound is placed at the render instead, and the total is stated rather than
 * implied.
 *
 * Integrators who want the real page are already served: `/trials?limit=&cursor=` paginates and
 * `/snapshot` is the whole picture. This file only decides what one visitor is asked to scroll
 * through, and says so out loud when it withholds a row.
 */

export const TRIALS_PAGE = 50;

export interface Windowed<T> {
  /** The rows this render is allowed to draw. Never more than `limit`. */
  visible: T[];
  /** Rows the source holds that are not drawn yet. A number the reader is told. */
  withheld: number;
  total: number;
  hasMore: boolean;
}

/**
 * Take the first `shown` rows and report the rest as a count.
 *
 * `shown` is clamped to a whole multiple of `limit` rather than trusted: it arrives from a button
 * the visitor presses, and a page that renders whatever it is told is a page that can be asked for
 * all of it.
 */
export function windowed<T>(rows: readonly T[], shown: number, limit = TRIALS_PAGE): Windowed<T> {
  const total = rows.length;
  const wanted = Number.isFinite(shown) ? Math.max(0, Math.floor(shown / limit) * limit) : 0;
  const take = Math.min(wanted === 0 ? limit : wanted, total);
  return {
    visible: rows.slice(0, take),
    withheld: total - take,
    total,
    hasMore: take < total,
  };
}

/** The label beside the list, written so an empty and an uncounted list are different sentences. */
export function windowLabel(w: Windowed<unknown>): string {
  if (w.total === 0) return "nothing on the chain yet";
  if (!w.hasMore) return `all ${w.total} trial${w.total === 1 ? "" : "s"}, newest first`;
  return `showing ${w.visible.length} of ${w.total}, newest first — ${w.withheld} more behind`;
}
