import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/demo/guest",
  label: "Guest demo",
  purpose: "The no-wallet door: public trials, evaluations, scorecards and the guided walkthrough, with the demo limits stated.",
  can: [
    "read the public trials board",
    "follow the guided evidence walkthrough",
    "see scorecards and agent profiles",
  ],
  needs: "nothing - guests enter without a wallet",
};
