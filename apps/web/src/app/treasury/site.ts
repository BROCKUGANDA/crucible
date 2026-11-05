import type { SiteEntry } from "@crucible/site-index";

/**
 * The commission's destination, read from the chain rather than asserted by
 * this page: the escrow's own `treasury()`. The pending credit is shown only
 * when the connected wallet is that exact address.
 */
export const siteEntry: SiteEntry = {
  path: "/treasury",
  label: "Treasury Safe",
  purpose:
    "The company Treasury Safe: which address the escrow names for commission, and the calldata that moves it.",
  can: [
    "read the treasury address the deployed escrow holds",
    "copy the escrow address and the withdraw() calldata",
    "see the treasury's own pending credit when that Safe is connected",
  ],
  needs: "the deployed escrow address; the Safe itself to show its credit",
};
