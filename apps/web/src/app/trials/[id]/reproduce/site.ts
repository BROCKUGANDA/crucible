import type { SiteEntry } from "@crucible/site-index";

/**
 * What this page is, for the two readers of the site index.
 *
 * Frenchy is grounded in this to know where she may send a visitor and what she may point at; the
 * Tour page shows it to a visitor who wants the whole site at once. The generator refuses to emit
 * an entry whose route or points are not on the page, so this cannot describe a page that does not
 * exist.
 *
 * Worth stating next to `replay`'s entry, because the two are easy to conflate from a list: replay
 * re-reads what the chain recorded, in order. This one re-derives whether the evidence is the
 * evidence — the same bytes hashed again, the same signature recovered again, against sources that
 * do not include our index. A visitor asking "did this happen?" goes to replay; one asking "may I
 * believe you?" goes here.
 */
export const siteEntry: SiteEntry = {
  path: "/trials/[id]/reproduce",
  label: "Reproduce",
  purpose: "The run's bytes, signature and report, checked again from the chain and the store rather than from our index.",
  can: ["see each binding hold or fail", "read the digests and addresses to check yourself"],
};
