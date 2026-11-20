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
  path: "/studio",
  label: "Evaluation Studio",
  purpose:
    "Run a pinned task three times and find out whether the result would repeat.",
  can: [
    "check whether an evaluation is reproducible",
    "read why a verdict was inconclusive rather than pass",
  ],
  points: ["studio-panel"],
};
