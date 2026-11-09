import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/ops",
  label: "Ops",
  purpose: "The pilot's own health view: deploy profile, chain, and the guarded entry points that prove the pilot's invariants.",
  can: [
    "read the ops profile and chain proofs",
    "follow the links to the pilot reports",
  ],
  needs: "an operator session for anything beyond the public profile proof",
};
