import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/app",
  label: "Operator console",
  purpose: "The restricted operator surface: profile, chain, and profile-gate proofs, and where the rollout checklist, evidence, and go/no-go records live.",
  can: [
    "read the deployment profile",
    "read the pilot reports and runbooks",
  ],
  needs: "a restricted session; never a public page",
};
