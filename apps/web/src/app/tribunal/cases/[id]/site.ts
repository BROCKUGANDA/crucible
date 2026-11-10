import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/tribunal/cases/[id]",
  label: "Tribunal case",
  purpose: "One challenged claim in full: the charge, the claim, the challenge, the committee and the verdict.",
  can: ["see what was posted and by whom", "see the break filed against the claim", "see the seat seals and unseals", "see the verdict"],
  points: ["case-charge"],
};
