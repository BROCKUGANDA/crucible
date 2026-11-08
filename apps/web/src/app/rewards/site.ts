import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/rewards",
  label: "Rewards",
  purpose: "Real campaign claims via the live API: browse campaigns (EVM and Solana devnet), reserve a pending claim. Reservation is not payment.",
  can: ["browse campaigns", "reserve a claim"],
};
