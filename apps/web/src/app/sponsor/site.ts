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
  path: "/sponsor",
  label: "Sponsor console",
  purpose:
    "A sponsor's own programmes, and whether the escrow holds the money the programme says it deposited.",
  can: [
    "see a programme's budget next to what the chain confirms",
    "record a funding claim and have it checked against the chain",
  ],
  points: ["sponsor-panel"],
};
