import type { SiteEntry } from "@crucible/site-index";

/**
 * What this page is, for the two readers of the site index.
 *
 * Frenchy is grounded in this to know where she may send a visitor and what
 * she may point at; the Tour page shows it to a visitor who wants the whole
 * site at once. The generator refuses to emit an entry whose route or points
 * are not on the page, so this cannot describe a page that does not exist.
 */
export const siteEntry: SiteEntry = {
  path: "/developers/reference",
  label: "API reference",
  purpose: "The API's own rules — pagination, rate limits, signing and every error code it can return.",
  can: ["read the rate limit and the pagination rules", "look up what an error code means"],
  points: ["reference-panel"],
};
