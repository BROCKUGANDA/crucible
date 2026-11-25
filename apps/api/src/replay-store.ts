/**
 * @file replay-store.ts — where a replay manifest lives.
 *
 * The manifest IS the measurement: what was run, in which environment, by
 * which worker, and what each replay produced. It used to live in a module
 * map, which meant a restart erased it — and a published card or a frozen
 * dispute bundle would then describe a measurement that could no longer be
 * re-derived. A card that outlives its measurement is a claim with no
 * record.
 *
 * The store is chosen ONCE, at boot, and never per request (ADR-0033's
 * rule): a record written to one store and read from another is a record
 * that lies. Without a database the API runs on the in-memory store and
 * says so, in the boot log and in every response.
 */

import type { ReplayManifest, ReplayRecord } from "./replay-manifest.js";

export interface ReplayStore {
  /** Which store this is, for the boot log and the responses. */
  readonly kind: string;

  putManifest(manifest: ReplayManifest): Promise<void>;
  getManifest(manifestId: string): Promise<ReplayManifest | undefined>;
  listManifestsByTrial(trialId: string): Promise<ReplayManifest[]>;
  listManifestsByRun(runId: string): Promise<ReplayManifest[]>;

  putReplay(record: ReplayRecord): Promise<void>;
  getReplay(replayId: string): Promise<ReplayRecord | undefined>;
  listReplaysByManifest(manifestId: string): Promise<ReplayRecord[]>;

  /** For tests. */
  reset(): Promise<void>;
}

/**
 * The in-memory store.
 *
 * It is not a stand-in for the durable one: it is what the API runs with
 * when no database is configured, and the boot log says so, so nobody
 * mistakes a measurement for a record.
 */
export function memoryReplayStore(): ReplayStore {
  const manifests = new Map<string, ReplayManifest>();
  const replays = new Map<string, ReplayRecord>();

  return {
    kind: "memory",
    async putManifest(manifest) {
      manifests.set(manifest.manifestId, manifest);
    },
    async getManifest(manifestId) {
      return manifests.get(manifestId);
    },
    async listManifestsByTrial(trialId) {
      return [...manifests.values()].filter((manifest) => manifest.trialId === trialId);
    },
    async listManifestsByRun(runId) {
      return [...manifests.values()].filter((manifest) => manifest.runId === runId);
    },
    async putReplay(record) {
      replays.set(record.replayId, record);
    },
    async getReplay(replayId) {
      return replays.get(replayId);
    },
    async listReplaysByManifest(manifestId) {
      return [...replays.values()]
        .filter((record) => record.manifestId === manifestId)
        .sort((a, b) => a.replayNumber - b.replayNumber);
    },
    async reset() {
      manifests.clear();
      replays.clear();
    },
  };
}

let store: ReplayStore = memoryReplayStore();

/** Which store is in use: "memory" or "postgresql". */
export function replayStoreKind(): string {
  return store.kind;
}

/**
 * Choose the store. Called once, at boot.
 *
 * Choosing per request is how a record ends up written to one store and
 * read from another, so this is deliberately not something a route can do.
 */
export function configureReplayStore(next: ReplayStore): void {
  store = next;
}

/** The store in use. */
export function currentReplayStore(): ReplayStore {
  return store;
}
