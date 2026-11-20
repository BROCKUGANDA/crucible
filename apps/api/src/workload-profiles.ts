/**
 * @file workload-profiles.ts — the workload profiles, in one place.
 *
 * The run route and the studio both have to know which profiles exist, and a
 * second list is a list that disagrees: a profile the run route accepts and
 * the studio refuses (or the reverse) is a bug nobody would think to look
 * for.
 */

import type { WorkloadProfile } from "@crucible/eval";

export const WORKLOAD_PROFILES: readonly WorkloadProfile[] = [
  "SOFTWARE_ENGINEERING",
  "STRUCTURED_DATA",
  "AUTONOMOUS_FINANCE",
];
