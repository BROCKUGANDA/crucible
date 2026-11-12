import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/demo/investor",
  label: "Investor demo",
  purpose: "The curated walkthrough: problem, execution, evidence, result — with what the pilot cannot prove attached.",
  can: [
    "follow one trial end to end",
    "read what the pilot can prove",
    "read the pilot's own limitations",
  ],
  needs: "nothing - the walkthrough needs no wallet",
};
