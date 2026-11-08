import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/data",
  label: "Data & ETL",
  purpose: "Data contract validation: structural schema, uniqueness, PII policy, reconciliation counts for structured datasets.",
  can: ["validate a demo dataset against a versioned contract"],
};
