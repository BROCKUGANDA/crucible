/**
 * Whether a URL segment can name a published method at all.
 *
 * A published method is CONTENT-ADDRESSED: its id is `pub_` followed by the
 * first 32 hex characters of the digest of its own contents. The platform
 * mints no other shape of publication id, and every link this app writes is
 * `` `/publications/${publication.id}` ``.
 *
 * So a segment that is not that shape names no published method, and no
 * read is needed to say so. `/publications/nope`, `/publications/pub_zzz`
 * and `/publications/123` are provably absent and get a real 404 rather
 * than a page that says "no such publication" under a 200 — the soft 404
 * that `lib/trial-id.ts` exists to remove.
 *
 * A segment that IS well formed but has nothing behind it is not decidable
 * from the string alone: the card is read client-side from the API, and
 * that case renders the honest "no such publication" panel. The
 * distinction is the whole point of keeping this predicate separate from
 * the page — the 404 is a claim about arithmetic, not about the database.
 */
const PUBLICATION_ID = /^pub_[0-9a-f]{32}$/;

/** The publication id a segment names, or `null` when it provably names none. */
export function publicationIdFromSegment(segment: string | undefined | null): string | null {
  if (typeof segment !== "string") return null;
  return PUBLICATION_ID.test(segment) ? segment : null;
}
