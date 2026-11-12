import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/demo/agent",
  label: "Agent demo",
  purpose: "The local agent run path: the demo command, the runner guarantees, and an honest statement that hosted agent credentials are not issued.",
  can: [
    "run the pinned task locally",
    "read the runner guarantees",
    "see why hosted credentials are unavailable",
  ],
  needs: "a local checkout and a model-provider credential for a full run",
};
