/**
 * @file publication-id.test.ts — the segment a published method lives at.
 *
 * A published method is content-addressed: `pub_` plus 32 hex characters.
 * A segment that cannot name one is provably absent, and the route must
 * answer a real 404 rather than a page that says "no such publication"
 * under a 200 — the soft 404 that `lib/trial-id.ts` exists to remove.
 */

import { describe, it, expect } from "vitest";
import { publicationIdFromSegment } from "../src/lib/publication-id";

describe("publicationIdFromSegment", () => {
  it("accepts a content address the platform mints", () => {
    const id = `pub_${"a".repeat(32)}`;
    expect(publicationIdFromSegment(id)).toBe(id);
    const mixed = `pub_${"0123456789abcdef".repeat(2)}`;
    expect(publicationIdFromSegment(mixed)).toBe(mixed);
  });

  it("refuses a segment that cannot name a published method", () => {
    for (const segment of [
      "nope",
      "pub_",
      "pub_zzz",
      "pub_AAAA",
      "pub_",
      `${"a".repeat(31)}`,
      `pub_${"a".repeat(33)}`,
      "123",
      "",
      "pub_../etc/passwd",
    ]) {
      expect(publicationIdFromSegment(segment), segment).toBeNull();
    }
  });

  it("refuses a segment that is not a string at all", () => {
    expect(publicationIdFromSegment(undefined)).toBeNull();
    expect(publicationIdFromSegment(null)).toBeNull();
  });
});
