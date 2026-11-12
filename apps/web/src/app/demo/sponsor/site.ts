import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/demo/sponsor",
  label: "Sponsor demo",
  purpose: "The sponsor flow on the demo profile: pin the brief, escrow, set the bounds — with no real-value reward available.",
  can: [
    "rehearse the sponsor flow",
    "see the escrow and settlement path",
    "read the demo profile's hard limits",
  ],
  needs: "a SIWE session and organization membership on the preview or production profile",
};
