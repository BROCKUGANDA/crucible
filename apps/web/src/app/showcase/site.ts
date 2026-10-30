import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/showcase",
  label: "Showcase Arena",
  purpose: "Watch House Bouts, start a Ghost run with no wallet, or replay any settled trial.",
  can: ["watch a house bout", "start a ghost run", "replay a settled trial"],
  needs: "nothing - guests enter without a wallet",
};
