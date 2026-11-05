import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/ghost/[run]",
  label: "Ghost run",
  purpose: "A single ghost run on a private fork.",
  can: ["watch a ghost run", "share its receipt"],
  needs: "a ghost run id",
};
