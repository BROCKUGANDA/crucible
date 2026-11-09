/**
 * Cursor pagination for the list routes, in one place.
 *
 * The cursor is an item id, not an offset. An offset is wrong the moment anything is added
 * above it — the page shifts under a client that is already looking at one, and on a chain
 * that only ever grows, "row 10 onward" is a different set of rows on every request.
 *
 * No limit means the whole list, deliberately rather than lazily. A silent default cap is
 * a lie of omission: a monitor that counts trials would read a truncated page as a shorter
 * chain and call it healthy. Callers who want a page ask for one, and `truncated` plus
 * `nextCursor` say out loud that there is more.
 *
 * Two cursor types exist because two kinds of ids exist: numeric (trials, agents, queue
 * rows) and opaque strings (team keys, campaign ids, publication hashes). They share one
 * semantic; only the cursor's type differs, which is why the slicing below is one
 * implementation and the exports are thin.
 */

/** The largest page a caller may ask for. A "limit" is not a licence to ask for everything. */
export const MAX_PAGE = 500;

export interface PageRequest {
  limit: number | null;
  after: number | null;
  error: string | null;
}

export interface KeyPageRequest {
  limit: number | null;
  after: string | null;
  error: string | null;
}

function parseLimit(rawLimit: string | undefined): { limit: number | null; error: string | null } {
  if (rawLimit === undefined || rawLimit === "") return { limit: null, error: null };
  if (!/^\d+$/.test(rawLimit)) {
    return { limit: null, error: "limit must be a whole number of items" };
  }
  const limit = Number(rawLimit);
  if (limit < 1 || limit > MAX_PAGE) {
    return { limit: null, error: `limit must be between 1 and ${MAX_PAGE}` };
  }
  return { limit, error: null };
}

/** A numeric item-id cursor (`?limit=50&after=123`). */
export function parsePage(query: Record<string, string | undefined>): PageRequest {
  const { limit, error } = parseLimit(query.limit);
  if (error) return { limit: null, after: null, error };
  let after: number | null = null;
  const rawAfter = query.after;
  if (rawAfter !== undefined && rawAfter !== "") {
    if (!/^\d+$/.test(rawAfter)) {
      return { limit: null, after: null, error: "after must be an item id from a previous page" };
    }
    after = Number(rawAfter);
  }
  return { limit, after, error: null };
}

/**
 * An opaque item-key cursor (`?limit=50&after=payfi-recon`). The key is passed through
 * unchanged: this module never parses or normalises an id it did not mint, because a
 * hash or a team key is whatever the store said it was.
 */
export function parseKeyPage(query: Record<string, string | undefined>): KeyPageRequest {
  const { limit, error } = parseLimit(query.limit);
  if (error) return { limit: null, after: null, error };
  let after: string | null = null;
  const rawAfter = query.after;
  if (rawAfter !== undefined && rawAfter !== "") {
    if (rawAfter.length > 200) {
      return { limit: null, after: null, error: "after must be an item id from a previous page" };
    }
    after = rawAfter;
  }
  return { limit, after, error: null };
}

interface Slice<T> {
  items: T[];
  page: {
    limit: number | null;
    after: string | null;
    returned: number;
    total: number;
    truncated: boolean;
    nextCursor: string | null;
    cursorStale: boolean;
  };
}

function slicePage<T>(
  items: T[],
  keyOf: (item: T) => string,
  limit: number | null,
  after: string | null,
): Slice<T> {
  let start = 0;
  let cursorStale = false;
  if (after !== null) {
    const found = items.findIndex((item) => keyOf(item) === after);
    if (found === -1) {
      // Legitimate, not an error: a filtered list loses members as the chain settles
      // trials, so a cursor can age out between pages. Resuming from the start with the
      // flag set is honest; a 400 would blame the client for the chain moving.
      cursorStale = true;
    } else {
      start = found + 1;
    }
  }
  const rest = items.slice(start);
  const slice = limit === null ? rest : rest.slice(0, limit);
  const more = start + slice.length < items.length;
  return {
    items: slice,
    page: {
      limit,
      after,
      returned: slice.length,
      total: items.length,
      truncated: limit !== null && more,
      nextCursor: limit !== null && more && slice.length ? keyOf(slice[slice.length - 1]!) : null,
      cursorStale,
    },
  };
}

/** Paginate a list addressed by a numeric item id (the original contract, unchanged). */
export function paginate<T>(
  items: T[],
  idOf: (item: T) => number,
  page: PageRequest,
): { items: T[]; page: Record<string, unknown> } {
  const sliced = slicePage(items, (item) => String(idOf(item)), page.limit, page.after === null ? null : String(page.after));
  return {
    items: sliced.items,
    page: {
      ...sliced.page,
      // Preserved as a number: /trials and /agents always returned a numeric cursor.
      after: page.after,
      nextCursor: sliced.page.nextCursor === null ? null : Number(sliced.page.nextCursor),
    },
  };
}

/** Paginate a list addressed by an opaque string key. */
export function paginateByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
  page: KeyPageRequest,
): { items: T[]; page: Record<string, unknown> } {
  const sliced = slicePage(items, keyOf, page.limit, page.after);
  return { items: sliced.items, page: sliced.page };
}
