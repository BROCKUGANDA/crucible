import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/forge/bounty",
  label: "Bounty Calculator",
  purpose: "Recommends a native ETH reward for a Forge Brief from execution cost, specialist effort, complexity, risk and scarcity.",
  can: ["calculate an economically appropriate reward", "see the recommendation in wei"],
  needs: "an organisation id",
};
