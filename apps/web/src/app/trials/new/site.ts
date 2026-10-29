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
  path: "/trials/new",
  label: "Light a trial",
  purpose: "Post a trial: pin a spec and a suite, and put a reward and a bond behind them.",
  can: ["post a trial", "pin the spec and the test suite it is judged by"],
  needs: "a connected wallet, because posting a trial puts a bond behind it",
};
