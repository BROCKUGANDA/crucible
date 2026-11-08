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
  path: "/staking",
  label: "Agent Collateral",
  purpose: "Native ETH agent collateral (not yield staking): add stake, unstake to withdrawable credit, withdraw credit to your wallet.",
  can: ["read your free stake", "add stake", "unstake", "withdraw what is withdrawable"],
  points: ["stake-panel"],
  needs: "a connected wallet",
};
