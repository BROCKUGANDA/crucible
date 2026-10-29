/**
 * Whether a URL segment can name a trial at all — decided without reading the chain.
 *
 * `/trials/999`, `/trials/0` and `/trials/abc` all answered **HTTP 200** on the deployed origin
 * (the 2026-10-29 browser audit), because the detail page resolves its data client-side from the
 * snapshot stream and renders "Lost slag." when nothing matches. A not-found *body* with a 200
 * status is a soft 404: the page says one thing and the protocol says another, which is what
 * crawlers, link-checkers and a judge's `curl` read.
 *
 * The full fix would need the id known at render time, and it is not: this app holds no database
 * (ADR-0008 — the indexer is in-memory, `apps/api` is the only reader, and the browser streams it
 * from there). A server component cannot answer "does trial 999 exist" without putting a chain
 * read into the page render, which is the architecture this project deliberately does not have.
 *
 * What *is* knowable from the string alone, and so is what this function decides:
 *
 *   * `CrucibleTrials.sol:405` mints ids with `id = ++trialCount`, so a trial id is a **positive
 *     integer**, and the first one is `1`.
 *   * Every link to this route is written by this app as `` `/trials/${trial.id}` `` with
 *     `trial.id` a JS number, i.e. always in canonical decimal form. There is no zero-padded,
 *     signed, hexadecimal or exponent form of an id anywhere in the product's own markup.
 *
 * So a segment that is not canonical decimal for an integer ≥ 1 names no trial, and no read is
 * needed to say so. `/trials/0`, `/trials/-3`, `/trials/1.5`, `/trials/007`, `/trials/1e3` and
 * `/trials/abc` are provably absent and get a real 404.
 *
 * A segment that *is* well formed but has no trial behind it (`/trials/999`) is not decidable
 * here, and this file does not pretend otherwise: that case still renders the client-side
 * "Lost slag." panel with a 200. The distinction is the whole point of keeping this predicate
 * separate from the page — the 404 is a claim about arithmetic, not about the chain.
 */
const CANONICAL_ID = /^[1-9][0-9]*$/;

/** The trial id a segment names, or `null` when it provably names no trial. */
export function trialIdFromSegment(segment: string | undefined | null): number | null {
  if (typeof segment !== "string") return null;
  // `params.id` arrives percent-decoded by Next, but a segment can still be `undefined` when the
  // route is rendered outside a request (the build's prerender pass, a test, a fixture).
  if (!CANONICAL_ID.test(segment)) return null;
  const id = Number(segment);
  // A decimal string too long to be a safe integer is also refused, and that is not a shortcut:
  // `trialCount` grows by exactly one per `createTrial`, so reaching 2^53 ids needs more than nine
  // quadrillion transactions, and the projection this page reads types ids as JS `number`s. Such
  // a trial is absent from the chain and unrepresentable here — a 404 is the true answer, and
  // rendering "not found" under a 200 would be the soft-404 this file exists to remove.
  return Number.isSafeInteger(id) ? id : null;
}
