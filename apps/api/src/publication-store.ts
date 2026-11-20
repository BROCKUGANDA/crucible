/**
 * @file publication-store.ts — where a published method lives.
 *
 * A published method is the audit artifact of an evaluation: it says what
 * was measured, against what, and what the number does not establish. It
 * has to outlive the process — a card that evaporates on restart is a claim
 * with no record.
 *
 * The store is chosen ONCE, at boot, and never per request
 * (ADR-0033): a record written to one store and read from another is a
 * record that lies. Two implementations exist:
 *
 *   - `pgPublicationStore` — PostgreSQL. What production runs.
 *   - `memoryPublicationStore` — a Map. For tests and for a laptop running
 *     the API without a database, and it SAYS SO: `publicationStoreKind()`
 *     is what the health endpoint and the console read, so nobody mistakes
 *     a laptop's memory for a record.
 *
 * The card itself is content-addressed by the domain module
 * (`publication.ts`); this file only moves it.
 */

import type { PublishedMethod } from "./publication.js";

/** A recorded comparison between two published cards. */
export interface StoredComparison {
  id: string;
  leftId: string;
  rightId: string;
  comparable: boolean;
  reason: string;
  differences: string[];
  comparedAt: number;
}

/** The filter for listing published cards. */
export interface PublicationFilter {
  subjectId?: string;
  kind?: "run" | "trial";
  comparabilityKey?: string;
  limit?: number;
}

/** The store a published method lives in. */
export interface PublicationStore {
  /** Record a published method. The same card twice is the same card. */
  record(method: PublishedMethod): Promise<PublishedMethod>;
  /** The card with this id, or null. */
  get(id: string): Promise<PublishedMethod | null>;
  /** The cards matching a filter, newest first. */
  list(filter: PublicationFilter): Promise<PublishedMethod[]>;
  /** Record a comparison. */
  recordComparison(input: Omit<StoredComparison, "id">): Promise<StoredComparison>;
  /** The comparisons recorded against a card. */
  listComparisons(methodId: string): Promise<StoredComparison[]>;
}

/* ------------------------------------------------------------------ */
/* The in-memory store                                                */
/* ------------------------------------------------------------------ */

export function memoryPublicationStore(): PublicationStore {
  const cards = new Map<string, PublishedMethod>();
  const comparisons = new Map<string, StoredComparison>();

  return {
    async record(method) {
      const existing = cards.get(method.id);
      if (existing) return existing;
      cards.set(method.id, method);
      return method;
    },
    async get(id) {
      return cards.get(id) ?? null;
    },
    async list(filter) {
      const all = [...cards.values()];
      return all
        .filter((card) => (filter.subjectId ? card.subject.id === filter.subjectId : true))
        .filter((card) => (filter.kind ? card.subject.kind === filter.kind : true))
        .filter((card) =>
          filter.comparabilityKey ? card.comparabilityKey === filter.comparabilityKey : true,
        )
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, filter.limit ?? 100);
    },
    async recordComparison(input) {
      const id = `cmp_${input.leftId}_${input.rightId}`.slice(0, 200);
      const stored: StoredComparison = { id, ...input };
      comparisons.set(id, stored);
      return stored;
    },
    async listComparisons(methodId) {
      return [...comparisons.values()]
        .filter((c) => c.leftId === methodId || c.rightId === methodId)
        .sort((a, b) => b.comparedAt - a.comparedAt);
    },
  };
}

/* ------------------------------------------------------------------ */
/* The chosen store                                                   */
/* ------------------------------------------------------------------ */

let activeStore: PublicationStore = memoryPublicationStore();
let activeKind = "memory";

/**
 * Choose the store. Called ONCE at boot.
 *
 * After this, the store does not change for the life of the process: a
 * request that read from one store and wrote to another would be a record
 * that lies.
 */
export function configurePublicationStore(store: PublicationStore, kind: string): void {
  activeStore = store;
  activeKind = kind;
}

/** The store in use. */
export function getPublicationStore(): PublicationStore {
  return activeStore;
}

/** Which store is in use: "postgresql" or "memory". */
export function publicationStoreKind(): string {
  return activeKind;
}

/** Reset to the in-memory store. For tests. */
export function resetPublicationStore(): void {
  activeStore = memoryPublicationStore();
  activeKind = "memory";
}
