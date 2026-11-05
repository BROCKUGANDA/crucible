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
  path: "/trials",
  label: "Trials",
  purpose: "Every trial on the chain, and what state each one is in.",
  can: ["read the open trials", "read the latest verdicts", "start a new trial"],
  points: ["trial-table"],
};
