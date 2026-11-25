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
  path: "/reviews",
  label: "Review queue",
  purpose: "Take a case waiting for a reviewer, or step away from one.",
  can: [
    "see what is waiting for a reviewer",
    "declare a conflict of interest with a case",
  ],
  points: ["reviews-panel"],
};
