import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/finance",
  label: "Finance",
  purpose: "PAPER-mode finance mandate checks: deterministic risk engine validates instrument allowlist, notional and concentration limits. No real money moves.",
  can: ["risk-check an order proposal against a mandate"],
};
