import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/ghost",
  label: "Ghost run",
  purpose: "Run a whole trial on a private fork with play money and no wallet.",
  can: ["start a ghost run", "play any role", "share a watermarked receipt"],
  needs: "nothing - guests enter without a wallet",
};
