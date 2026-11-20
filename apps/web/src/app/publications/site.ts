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
  path: "/publications",
  label: "Published methods",
  purpose:
    "Read what a published score was measured against, and what it does not establish.",
  can: [
    "read the limits a published score carries",
    "find out whether two scores may be compared at all",
  ],
  points: ["publications-panel"],
};
