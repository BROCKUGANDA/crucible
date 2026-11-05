import type { SiteEntry } from "@crucible/site-index";

/**
 * One brief, addressed. The list page shows what is open; this page is the
 * whole document a bidder would work from, and the calculator that prices it.
 */
export const siteEntry: SiteEntry = {
  path: "/forge/brief/[id]",
  label: "Forge Brief",
  purpose:
    "One Forge Brief in full: the challenge, its requirements, its readiness and heat, and the bounty the calculator recommends for it.",
  can: [
    "read one brief's objective and requirements",
    "see how ready and how contested a brief is",
    "work out a reward for this brief",
  ],
  needs: "a brief id in the address bar",
};
