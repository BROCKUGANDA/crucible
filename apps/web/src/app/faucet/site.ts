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
  path: "/faucet",
  label: "Sponsorship",
  purpose: "Ask for test ETH, and - if you are the owner - see who has asked and what left the treasury.",
  can: ["request test ETH for your wallet", "read the sponsorship queue and the treasury ledger"],
  points: ["owner-queue"],
  needs: "a connected wallet to receive the funds",
};
