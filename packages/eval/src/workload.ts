/**
 * @file workload.ts — Adapter registry + task-package validators.
 * Blueprint §2/§6. One registry; workload profiles extend Trial/Run.
 */

import type { WorkloadProfile, WorkloadAdapter } from "./workload-contracts.js";
import { softwareEngineeringAdapter } from "./workload-software.js";
import { structuredDataAdapter } from "./workload-data.js";
import { autonomousFinanceAdapter } from "./workload-finance.js";
import { solanaEngineeringAdapter } from "./workload-solana.js";

export type WorkloadKind = WorkloadProfile | "SOLANA_ENGINEERING";

const registry = new Map<WorkloadProfile, WorkloadAdapter>();

registry.set("SOFTWARE_ENGINEERING", softwareEngineeringAdapter as WorkloadAdapter);
registry.set("STRUCTURED_DATA", structuredDataAdapter as WorkloadAdapter);
registry.set("AUTONOMOUS_FINANCE", autonomousFinanceAdapter as WorkloadAdapter);

export function getAdapter(profile: string): WorkloadAdapter {
  if (profile === "SOLANA_ENGINEERING") return solanaEngineeringAdapter as unknown as WorkloadAdapter;
  const a = registry.get(profile as WorkloadProfile);
  if (!a) throw new Error(`unknown workload profile: ${profile}`);
  return a;
}

export function listAdapters(): { profile: string; version: string }[] {
  const base = [...registry.values()].map((a) => ({ profile: a.profile as string, version: a.version }));
  return [...base, { profile: "SOLANA_ENGINEERING", version: solanaEngineeringAdapter.version }];
}
