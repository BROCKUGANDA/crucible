import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/forge/brief",
  label: "Forge Brief",
  purpose: "The sponsor describes the problem before difficulty or reward is calculated.",
  can: ["describe a trial brief", "open a brief detail page"],
  needs: "a connected wallet and an organisation id",
};
