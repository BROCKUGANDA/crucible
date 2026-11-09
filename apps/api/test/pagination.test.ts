import { describe, expect, it } from "vitest";
import {
  MAX_PAGE,
  paginate,
  paginateByKey,
  parseKeyPage,
  parsePage,
} from "../src/pagination.js";

/**
 * The pagination contract every list route shares.
 *
 * Two properties matter and both are asserted here: no limit means the whole list (a
 * silent default cap would make a truncated page read as a shorter chain), and a cursor
 * is an item id, so a stale one resumes from the start with `cursorStale` rather than
 * blaming the client for the chain moving.
 */

describe("parsePage", () => {
  it("accepts a bounded limit and a numeric cursor", () => {
    expect(parsePage({})).toEqual({ limit: null, after: null, error: null });
    expect(parsePage({ limit: "10", after: "5" })).toEqual({ limit: 10, after: 5, error: null });
  });

  it("refuses a limit outside 1..MAX_PAGE", () => {
    expect(parsePage({ limit: "0" }).error).toMatch(/between 1 and/);
    expect(parsePage({ limit: String(MAX_PAGE + 1) }).error).toMatch(/between 1 and/);
    expect(parsePage({ limit: "ten" }).error).toMatch(/whole number/);
  });

  it("refuses a non-numeric cursor", () => {
    expect(parsePage({ after: "abc" }).error).toMatch(/previous page/);
  });
});

describe("paginate", () => {
  const rows = [1, 2, 3, 4, 5].map((id) => ({ id }));

  it("returns the whole list when no limit is asked, deliberately", () => {
    const { items, page } = paginate(rows, (row) => row.id, parsePage({}));
    expect(items).toHaveLength(5);
    expect(page).toMatchObject({ total: 5, returned: 5, truncated: false, nextCursor: null });
  });

  it("pages from an item id and says there is more", () => {
    const { items, page } = paginate(rows, (row) => row.id, parsePage({ limit: "2", after: "2" }));
    expect(items.map((row) => row.id)).toEqual([3, 4]);
    expect(page).toMatchObject({ total: 5, returned: 2, truncated: true, nextCursor: 4 });
  });

  it("resumes from the start with cursorStale when the cursor aged out", () => {
    const { items, page } = paginate(rows, (row) => row.id, parsePage({ limit: "2", after: "99" }));
    expect(items.map((row) => row.id)).toEqual([1, 2]);
    expect(page.cursorStale).toBe(true);
  });

  it("keeps the numeric cursor type the list routes always returned", () => {
    const { page } = paginate(rows, (row) => row.id, parsePage({ limit: "2" }));
    expect(page.nextCursor).toBe(2);
    expect(page.after).toBeNull();
  });
});

describe("parseKeyPage / paginateByKey", () => {
  const rows = ["a", "b", "c"].map((key) => ({ key }));

  it("carries an opaque key unchanged and pages from it", () => {
    const { items, page } = paginateByKey(rows, (row) => row.key, parseKeyPage({ limit: "1", after: "b" }));
    expect(items).toEqual([{ key: "c" }]);
    expect(page).toMatchObject({ total: 3, returned: 1, truncated: false, after: "b", nextCursor: null });
  });

  it("refuses a key far longer than any id this API mints", () => {
    expect(parseKeyPage({ after: "x".repeat(201) }).error).toMatch(/previous page/);
  });

  it("flags a stale key the same way as a stale numeric cursor", () => {
    const { page } = paginateByKey(rows, (row) => row.key, parseKeyPage({ limit: "1", after: "zzz" }));
    expect(page.cursorStale).toBe(true);
  });
});
