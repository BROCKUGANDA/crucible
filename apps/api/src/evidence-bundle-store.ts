/**
 * @file evidence-bundle-store.ts — where a frozen bundle lives.
 *
 * A bundle is evidence in a dispute, so it has to outlive the process: a
 * committee that comes back to the bundle next week must find the same one
 * the parties saw. The store is chosen ONCE, at boot, and never per request
 * (ADR-0033): a record written to one store and read from another is a
 * record that lies.
 *
 * Two implementations exist:
 *
 *   - `pgEvidenceBundleStore` — PostgreSQL. What production runs.
 *   - `memoryEvidenceBundleStore` — a Map. For tests and for a laptop
 *     running the API without a database, and it SAYS SO:
 *     `evidenceBundleStoreKind()` is what the boot log and the read
 *     responses report, so nobody mistakes a laptop's memory for a record.
 */

import type { EvidenceBundle } from "./evidence-bundle.js";

export interface StoredBundle {
  bundle: EvidenceBundle;
  sealedAt: number;
  /** Whether the bundle predates the dispute, when that is known. */
  predatesDispute: boolean | null;
}

export interface EvidenceBundleStore {
  /** Record a frozen bundle. The same bundle twice is the same row. */
  record(bundle: EvidenceBundle, predatesDispute: boolean | null): Promise<StoredBundle>;
  /** The bundle with this id, or null. */
  get(id: string): Promise<StoredBundle | null>;
  /** Every bundle sealed for a trial, oldest first. */
  listForTrial(trialKey: string): Promise<StoredBundle[]>;
}

/* ------------------------------------------------------------------ */
/* The in-memory store                                               */
/* ------------------------------------------------------------------ */

export function memoryEvidenceBundleStore(): EvidenceBundleStore {
  const bundles = new Map<string, StoredBundle>();

  return {
    async record(bundle, predatesDispute) {
      const existing = bundles.get(bundle.id);
      if (existing) return existing;
      const stored: StoredBundle = { bundle, sealedAt: bundle.sealedAt, predatesDispute };
      bundles.set(bundle.id, stored);
      return stored;
    },
    async get(id) {
      return bundles.get(id) ?? null;
    },
    async listForTrial(trialKey) {
      return [...bundles.values()]
        .filter((stored) => stored.bundle.trialKey === trialKey)
        .sort((a, b) => a.sealedAt - b.sealedAt);
    },
  };
}

/* ------------------------------------------------------------------ */
/* The chosen store                                                  */
/* ------------------------------------------------------------------ */

let activeStore: EvidenceBundleStore = memoryEvidenceBundleStore();
let activeKind = "memory";

/** Choose the store. Called ONCE at boot. */
export function configureEvidenceBundleStore(store: EvidenceBundleStore, kind: string): void {
  activeStore = store;
  activeKind = kind;
}

/** The store in use. */
export function getEvidenceBundleStore(): EvidenceBundleStore {
  return activeStore;
}

/** Which store is in use: "postgresql" or "memory". */
export function evidenceBundleStoreKind(): string {
  return activeKind;
}

/** Reset to the in-memory store. For tests. */
export function resetEvidenceBundleStore(): void {
  activeStore = memoryEvidenceBundleStore();
  activeKind = "memory";
}
