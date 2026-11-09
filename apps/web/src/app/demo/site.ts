import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/demo",
  label: "7-hour pilot demo",
  purpose: "The no-wallet walkthrough: seeded deterministic trials, evidence, and the demo's own known limitations.",
  can: [
    "walk the pilot story without a wallet",
    "read the demo-only disclosure",
    "inspect the pilot's known limitations",
  ],
  needs: "nothing - guests enter without a wallet",
};
