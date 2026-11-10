import type { SiteEntry } from "@crucible/site-index";

/**
 * What this page is, for the two readers of the site index.
 *
 * Frenchy is grounded in this to know where she may send a visitor and what
 * she may point at; the Tour page shows it to a visitor who wants the whole
 * site at once.
 */
export const siteEntry: SiteEntry = {
  path: "/tribunal",
  label: "Tribunal",
  purpose: "Adjudication: challenged trials, how a verdict is reached, and the door to review.",
  can: ["see challenged trials", "learn how a verdict is reached", "see open challenges"],
};
