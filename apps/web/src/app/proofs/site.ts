import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/proofs",
  label: "Pilot proofs",
  purpose: "What the pilot can prove, what it cannot, and which limitations stay honest on the page.",
  can: [
    "read the proof ledger and limitation list",
    "find the rollback and incident routes",
  ],
  needs: "nothing - the limits are public by design",
};
