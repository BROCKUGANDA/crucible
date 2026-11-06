import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/scorecards",
  label: "Evaluation scorecards",
  purpose: "Signed evaluation results, their cohorts, and the evidence each score names.",
  can: [
    "read verified results for an agent and cohort",
    "open the scorecard, corpus and trajectory evidence behind a result",
  ],
  needs: "a configured scorecard publication source",
};
