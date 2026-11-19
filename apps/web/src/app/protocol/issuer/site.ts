import type { SiteEntry } from "@crucible/site-index";

export const siteEntry: SiteEntry = {
  path: "/protocol/issuer",
  label: "Issuer console",
  purpose:
    "The private issuer surface: instruments, the frozen Schedule 2 snapshot, observed payments, notices and the structuring event, all authorised against the API's reviewer list.",
  can: [
    "create an issuer, holders and draft instruments",
    "freeze a Schedule 2 allocation snapshot",
    "record and verify an observed payment",
    "schedule and deliver a contractual notice",
    "prepare and reconcile the token structuring event",
  ],
  needs: "a signed-in wallet on the host's reviewer list",
};
