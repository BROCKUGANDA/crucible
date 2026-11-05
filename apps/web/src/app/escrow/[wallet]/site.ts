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
  path: "/escrow/[wallet]",
  label: "Escrow",
  purpose: "One wallet's escrow: what is locked in trials, what is free stake, and what it can claim.",
  can: ["read one wallet's balances", "see the trial that holds the stake"],
  points: ["escrow-balances"],
  needs: "a wallet address in the address bar",
};
