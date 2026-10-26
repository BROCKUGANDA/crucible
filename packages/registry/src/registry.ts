// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 753 — One-registry consolidation.
 *
 * A single content-addressed registry for agents, suites, and datasets.
 * Each entry's ID = sha256(JCS(manifest)), making entries immutable and
 * deduplicated: same content = same ID, different content = different ID.
 *
 * The registry is in-memory (like the indexer, ADR-0008). It supports
 * registration, lookup by ID, lookup by name, and listing by kind.
 */

import { sha256, hashCanonical } from "@crucible/crypto";
import type {
  AgentManifest,
  EntryKind,
  LookupResult,
  RegistryEntry,
  RegistryStats,
  SuiteManifest,
} from "./types.js";

/** Internal entry record. */
interface StoredEntry {
  entryId: string;
  kind: EntryKind;
  manifest: AgentManifest | SuiteManifest;
}

/**
 * Compute the entryId from a manifest: sha256 over JCS-canonicalized JSON.
 */
export function entryIdFor(manifest: AgentManifest | SuiteManifest): string {
  return sha256(hashCanonical(manifest));
}

/**
 * Create a RegistryEntry from a manifest, computing the entryId.
 * Kind is derived from manifest.kind.
 */
export function createRegistryEntry(
  manifest: AgentManifest | SuiteManifest,
): RegistryEntry {
  const kind = manifest.kind as EntryKind;
  return { entryId: entryIdFor(manifest), kind, manifest };
}

/** Verify that a RegistryEntry's entryId matches recomputation. */
export function verifyEntryId(entry: RegistryEntry): boolean {
  return entry.entryId === entryIdFor(entry.manifest);
}

/**
 * The one-registry: agents, suites, datasets as content-addressed entries.
 *
 * Thread-safe single instance. Registration is idempotent: re-registering
 * the same manifest returns the same entryId without creating a duplicate.
 */
export class OneRegistry {
  private entries: Map<string, StoredEntry> = new Map();
  private byName: Map<string, string[]> = new Map();

  /** Register a manifest, returning its content-addressed entryId. */
  register(manifest: AgentManifest | SuiteManifest): string {
    const entryId = entryIdFor(manifest);
    const kind = manifest.kind as EntryKind;

    if (!this.entries.has(entryId)) {
      const stored: StoredEntry = { entryId, kind, manifest };
      this.entries.set(entryId, stored);

      const name = manifest.name;
      const existing = this.byName.get(name) ?? [];
      if (!existing.includes(entryId)) {
        existing.push(entryId);
        this.byName.set(name, existing);
      }
    }

    return entryId;
  }

  /** Look up an entry by its content-addressed ID. */
  getById(entryId: string): RegistryEntry | undefined {
    const stored = this.entries.get(entryId);
    if (!stored) return undefined;
    return {
      entryId: stored.entryId,
      kind: stored.kind,
      manifest: stored.manifest,
    };
  }

  /** Look up entries by name (may return multiple if names collide). */
  getByName(name: string): LookupResult {
    const ids = this.byName.get(name) ?? [];
    if (ids.length === 0) {
      return { found: false, matches: [] };
    }
    const entries = ids
      .map((id) => this.entries.get(id))
      .filter((e): e is StoredEntry => e !== undefined);
    return {
      found: true,
      entry: entries[0],
      matches: ids,
    };
  }

  /** List all entries of a given kind. */
  listByKind(kind: EntryKind): RegistryEntry[] {
    const result: RegistryEntry[] = [];
    for (const stored of this.entries.values()) {
      if (stored.kind === kind) {
        result.push({
          entryId: stored.entryId,
          kind: stored.kind,
          manifest: stored.manifest,
        });
      }
    }
    return result;
  }

  /** All entries in the registry. */
  listAll(): RegistryEntry[] {
    const result: RegistryEntry[] = [];
    for (const stored of this.entries.values()) {
      result.push({
        entryId: stored.entryId,
        kind: stored.kind,
        manifest: stored.manifest,
      });
    }
    return result;
  }

  /** Registry statistics. */
  stats(): RegistryStats {
    const byKind: Record<EntryKind, number> = {
      agent: 0,
      suite: 0,
      dataset: 0,
    };
    for (const stored of this.entries.values()) {
      byKind[stored.kind] = (byKind[stored.kind] ?? 0) + 1;
    }
    return { totalEntries: this.entries.size, byKind };
  }

  /** Clear all entries (for testing). */
  clear(): void {
    this.entries.clear();
    this.byName.clear();
  }

  /** Total number of entries. */
  size(): number {
    return this.entries.size;
  }
}
