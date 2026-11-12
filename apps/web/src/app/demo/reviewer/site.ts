import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/demo/reviewer",
  label: "Reviewer demo",
  purpose: "The reviewer role: blinded evidence, the decision trace, and the separation of review from sponsorship.",
  can: [
    "read blinded evidence and decision traces",
    "see the role's authorization requirements",
    "understand the dispute path",
  ],
  needs: "a reviewer role on the preview or production profile",
};
