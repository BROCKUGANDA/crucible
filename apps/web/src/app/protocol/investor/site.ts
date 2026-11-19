import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/protocol/investor",
  label: "Investor portal",
  purpose:
    "The holder's own view of the STAMP register: their instruments, their frozen portion, the 24-month lock-up and the delivery request.",
  can: [
    "read the instruments issued to this wallet",
    "see the portion from the frozen Schedule 2 snapshot",
    "submit a signed delivery request and prove the destination address",
    "follow the monthly release schedule once a delivery is approved",
  ],
  needs: "a signed-in wallet a reviewer has bound to a holder record",
};
