import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/solana",
  label: "Solana",
  purpose: "Solana console in sandbox: connect a Solana wallet, read the STAMP projection, follow the payment-to-delivery review queue. No delivery or issuance from this page.",
  can: ["connect a Solana wallet", "read the ownership projection"],
};
