import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/protocol",
  label: "Protocol · Ownership",
  purpose:
    "The STAMP protocol-ownership register: the public aggregate projection, the bands a launch must sit inside, the checks a delivery must pass, and a door into the issuer console and the investor portal.",
  can: [
    "read the public aggregate facts an issuer has published, with unknown figures shown as an em dash",
    "check which mode this host is in and whether its production preflight manifest matched",
    "see the allocation bands, the 24-month lock-up and the delivery checklist in plain words",
  ],
  needs: "The issuer's published identifier. The issuer and investor surfaces need their own authority, not a wallet.",
};
