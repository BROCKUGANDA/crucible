// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 753 — One-registry consolidation types.
 *
 * Agents, suites, and datasets are all content-addressed entries in a single
 * registry. Each entry has a content-hash ID (= sha256 of JCS-canonicalized
 * manifest), making entries immutable and deduplicated.
 */

/** Kind of registry entry. */
export type EntryKind = "agent" | "suite" | "dataset";

/** Common fields shared by all registry entry manifests. */
export interface RegistryEntryBase {
  /** Human-readable name. */
  name: string;
  /** Description of what this entry represents. */
  description: string;
  /** SPDX license identifier. */
  license: string;
  /** Provenance: who produced it, how, and when. */
  provenance: string;
  /** Unix ms timestamp of creation. */
  createdAt: number;
}

/** Agent manifest — describes an autonomous agent principal. */
export interface AgentManifest extends RegistryEntryBase {
  kind: "agent";
  /** EIP-8004-style domains this agent operates in. */
  domains: string[];
  /** The model backing the agent, e.g. "claude-sonnet-4-5". */
  model: string;
  /** Tools the agent may call. */
  tools: string[];
  /** Optional: hard limits the agent will not exceed. */
  limits?: Record<string, unknown>;
}

/** Suite manifest — describes a set of eval trials / probes. */
export interface SuiteManifest extends RegistryEntryBase {
  kind: "suite";
  /** Content-addressed dataset ID this suite draws probes from. */
  datasetId: string;
  /** Which split this suite is drawn from: train/dev/holdout. */
  split: "train" | "dev" | "holdout";
  /** Number of probes in this suite. */
  probeCount: number;
  /** Optional: schema URI for probe derivation. */
  derivationSchema?: string;
}

/** A registered registry entry — manifest plus its content-addressed ID. */
export interface RegistryEntry {
  /** entryId = sha256(JCS(manifest)) — content-derived, never a label. */
  entryId: string;
  kind: EntryKind;
  manifest: AgentManifest | SuiteManifest;
}

/** Result of a registry lookup. */
export interface LookupResult {
  /** Whether the entry was found. */
  found: boolean;
  /** The entry, if found. */
  entry?: RegistryEntry;
  /** All entry IDs matching the name, if any. */
  matches?: string[];
}

/** Registry statistics. */
export interface RegistryStats {
  totalEntries: number;
  byKind: Record<EntryKind, number>;
}
