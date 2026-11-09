import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/developers",
  label: "Developer pilot",
  purpose: "The fastest path from zero to a submitted run: the SDK, the agent contract, and the scoped-token flow explained briefly.",
  can: [
    "read the agent contract and quick start",
    "follow the five-minute sample-agent path",
  ],
  needs: "nothing to read; an agent credential to submit",
};
