import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/replay/[id]",
  label: "Replay Theater",
  purpose: "Re-enact any settled trial on a scrubbable timeline.",
  can: ["scrub a timeline", "jump to the twist", "replay commentary"],
  needs: "a settled trial id",
};
