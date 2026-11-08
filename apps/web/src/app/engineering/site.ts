import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/engineering",
  label: "Engineering",
  purpose: "Deterministic regression-repair trials: run a pinned task, verify baseline fails, execute in an isolated sandbox, score public and hidden regression.",
  can: ["run a demo regression repair", "view a versioned scorecard"],
};
