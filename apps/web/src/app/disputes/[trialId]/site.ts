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
  path: "/disputes/[trialId]",
  label: "Dispute evidence",
  purpose:
    "The frozen evidence of a dispute: what the chain said, what was measured, and what is missing.",
  can: [
    "read what a dispute bundle does not contain",
    "check whether a bundle was sealed before the trial was broken",
  ],
  points: ["dispute-evidence-panel"],
};
