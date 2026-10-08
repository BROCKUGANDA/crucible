/**
 * A bounded, content-addressed store — the thing that makes a recorded CID fetchable.
 *
 * The chain holds a hash of a run artifact; the bytes are somebody else's problem. They
 * are this store's problem: the runner publishes the artifact, the suite output and the
 * logs under ids computed from those bytes, and Argus later asks for those same ids and
 * re-runs whatever comes back. If the store cannot answer, the deterministic half of a
 * dispute collapses into the model-backed half, which is slower, dearer and weaker. That
 * is the gap this fills.
 *
 * Three properties carry the design:
 *
 *   Content-addressed. The key is the sha2-256 of the payload, so an identical put is a
 *   no-op, and the CIDv0 and CIDv1 spellings of the same bytes are the same entry. Two
 *   processes that disagree about which textual form to use still find each other's data.
 *
 *   Shared through the directory. There is no index file and no lock, because a runner
 *   writing while a verifier reads is the normal case, not the exception: an index owned
 *   by one process is stale or contested in the other. Sizes and ages come from the
 *   filesystem, which both see, and a put lands as a complete file through a temporary
 *   name plus a rename, so a reader never observes half an entry.
 *
 *   Bounded. Every run ever made is not a cache, and it will fill the disk of the host
 *   that has to keep verifying runs. So: a byte ceiling, an entry ceiling, a hard
 *   per-entry limit, and oldest-first eviction. Refusals are errors, never silent drops
 *   — a runner that believes it published something that was quietly discarded has just
 *   made a claim the chain cannot back.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bytesEqual,
  cidFromDigest,
  sha256,
  toBytes,
  toHex,
  tryDecodeCid,
  type CidVersion,
  type Content,
} from "./cid.js";
import { canonicalJson } from "./json.js";

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 256;
export const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

export interface CidStoreOptions {
  /**
   * Directory to keep content under. Omit it and the store is in-memory — same code,
   * same limits, same eviction — for tests and for pinning bytes for one process only.
   */
  dir?: string;
  /** ceiling on the bytes held; the store evicts oldest-first to stay under it. */
  maxBytes?: number;
  /** ceiling on the number of entries. */
  maxEntries?: number;
  /** hard limit on one entry; larger content is refused rather than evicting the world. */
  maxEntryBytes?: number;
  /** which textual form `put` returns. Both forms resolve on `get` either way. */
  cidVersion?: CidVersion;
}

export interface CidStoreStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  dir: string | null;
}

export class CidStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CidStoreError";
  }
}

export class EntryTooLargeError extends CidStoreError {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`content is ${bytes} bytes, over the ${limit} byte per-entry limit`);
    this.name = "EntryTooLargeError";
  }
}

export class StoreFullError extends CidStoreError {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`content is ${bytes} bytes, over the ${maxBytes} byte store ceiling`);
    this.name = "StoreFullError";
  }
}

export class ContentCorruptedError extends CidStoreError {
  constructor(
    readonly cid: string,
    readonly key: string,
  ) {
    super(`content stored under ${key} does not hash to ${cid}`);
    this.name = "ContentCorruptedError";
  }
}

interface Entry {
  key: string;
  bytes: number;
  /** insertion stamp; the order eviction follows */
  at: number;
}

interface Backend {
  entries(): Entry[];
  has(key: string): boolean;
  read(key: string): Uint8Array | null;
  write(key: string, bytes: Uint8Array, at: number): void;
  remove(key: string): void;
}

/**
 * The whole store when it is in memory. Memory has an exact insertion order, so it keeps
 * its own counter instead of the wall clock the disk backend has to fight for a
 * millisecond with — a test that evicts in publication order should not depend on how
 * coarse the filesystem's timestamps are.
 */
class MemoryBackend implements Backend {
  private readonly items = new Map<string, Uint8Array>();

  /** A Map iterates in insertion order, which is exactly the eviction order. */
  entries(): Entry[] {
    let at = 0;
    return [...this.items].map(([key, bytes]) => ({ key, bytes: bytes.length, at: (at += 1) }));
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  read(key: string): Uint8Array | null {
    const found = this.items.get(key);
    // A copy, not the stored array: a caller that mutates what it read would otherwise
    // rewrite the content behind an id that is already on the chain.
    return found === undefined ? null : found.slice();
  }

  write(key: string, bytes: Uint8Array): void {
    this.items.set(key, bytes.slice());
  }

  remove(key: string): void {
    this.items.delete(key);
  }
}

/** Only files named by a 64-character hex digest are entries; the rest of the directory is not ours. */
const HEX_KEY = /^[0-9a-f]{64}$/;

let tempSerial = 0;

class DiskBackend implements Backend {
  private readonly dataDir: string;

  constructor(dir: string) {
    this.dataDir = join(dir, "data");
    mkdirSync(this.dataDir, { recursive: true });
  }

  entries(): Entry[] {
    return readdirSync(this.dataDir)
      .filter((name) => HEX_KEY.test(name))
      .map((key) => {
        const stats = statSync(join(this.dataDir, key));
        return { key, bytes: stats.size, at: stats.mtimeMs };
      });
  }

  has(key: string): boolean {
    try {
      return statSync(this.path(key)).isFile();
    } catch {
      return false;
    }
  }

  read(key: string): Uint8Array | null {
    try {
      // A copy rather than the Buffer readFileSync hands over: the public type is
      // Uint8Array, and what a caller does with it must not reach anything else.
      return new Uint8Array(readFileSync(this.path(key)));
    } catch {
      return null;
    }
  }

  /**
   * `at` is stamped onto the file instead of being trusted from the clock: entries
   * written in the same millisecond share a natural mtime on a real filesystem, and
   * eviction that cannot order them evicts the wrong one. One millisecond per entry is
   * enough to keep publication order and costs a single extra syscall.
   */
  write(key: string, bytes: Uint8Array, at: number): void {
    const temp = join(this.dataDir, `.tmp-${key}-${process.pid}-${(tempSerial += 1)}`);
    writeFileSync(temp, bytes);
    utimesSync(temp, new Date(at), new Date(at));
    try {
      renameSync(temp, this.path(key));
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  remove(key: string): void {
    rmSync(this.path(key), { force: true });
  }

  private path(key: string): string {
    return join(this.dataDir, key);
  }
}

export class CidStore {
  private readonly backend: Backend;
  private readonly dir: string | null;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly cidVersion: CidVersion;
  /** the stamp last used here, so a busy process keeps a strict order */
  private lastAt = 0;

  constructor(options: CidStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new CidStoreError(`maxBytes must be a positive integer, got ${maxBytes}`);
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new CidStoreError(`maxEntries must be a positive integer, got ${maxEntries}`);
    }
    // An entry larger than the whole ceiling could only be stored by evicting everything
    // and still not fitting, so the per-entry limit is clamped to it: the caller gets one
    // clean refusal instead of an eviction storm.
    const maxEntryBytes = Math.min(options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES, maxBytes);

    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.maxEntryBytes = maxEntryBytes;
    this.cidVersion = options.cidVersion ?? "v1";
    this.dir = options.dir ?? null;
    this.backend = this.dir === null ? new MemoryBackend() : new DiskBackend(this.dir);
  }

  /** Reads better than `new CidStore({})` in a test, and cannot be mistaken for disk-backed. */
  static inMemory(options: Omit<CidStoreOptions, "dir"> = {}): CidStore {
    return new CidStore(options);
  }

  /** Store the content and return the id that fetches it back. */
  put(content: Content): string {
    const bytes = toBytes(content);
    // Ceiling first: content larger than the whole store could not be made to fit by
    // evicting everything, so "you will never have room for this" is the true refusal.
    // The per-entry limit then catches the ordinary case of one oversized payload.
    if (bytes.length > this.maxBytes) throw new StoreFullError(bytes.length, this.maxBytes);
    if (bytes.length > this.maxEntryBytes) {
      throw new EntryTooLargeError(bytes.length, this.maxEntryBytes);
    }

    const key = toHex(sha256(bytes));
    // Identical bytes are one entry, whoever wrote them and however many times: the
    // re-put must not disturb the eviction order or the accounting.
    if (this.backend.has(key)) return this.cidOf(key);

    const held = this.held();
    this.makeRoom(held, bytes.length);
    this.backend.write(key, bytes, this.stamp(held));
    return this.cidOf(key);
  }

  /** The id these bytes would be stored under, without storing them. */
  cidFor(content: Content): string {
    return this.cidOf(toHex(sha256(toBytes(content))));
  }

  putJson(value: unknown): string {
    return this.put(canonicalJson(value));
  }

  /** `null` for an id that names nothing here; throws when an entry is present but wrong. */
  getBytes(cid: string): Uint8Array | null {
    const parts = tryDecodeCid(cid);
    if (parts === null) return null;
    const key = toHex(parts.digest);
    const bytes = this.backend.read(key);
    if (bytes === null) return null;
    // Loud on corruption: a verifier told "no such content" when the content is there
    // but damaged would blame the runner for a failure of this store.
    if (!bytesEqual(sha256(bytes), parts.digest)) throw new ContentCorruptedError(cid, key);
    return bytes;
  }

  get(cid: string): string | null {
    const bytes = this.getBytes(cid);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  getJson<T = unknown>(cid: string): T | null {
    const text = this.get(cid);
    return text === null ? null : (JSON.parse(text) as T);
  }

  /** True when an entry exists. Does not vouch for its bytes — `get` does that. */
  has(cid: string): boolean {
    const parts = tryDecodeCid(cid);
    return parts !== null && this.backend.has(toHex(parts.digest));
  }

  remove(cid: string): boolean {
    const parts = tryDecodeCid(cid);
    if (parts === null) return false;
    const key = toHex(parts.digest);
    if (!this.backend.has(key)) return false;
    this.backend.remove(key);
    return true;
  }

  /** The ids held, oldest-first: the order they would be evicted in. */
  list(): string[] {
    return this.held().map((entry) => this.cidOf(entry.key));
  }

  /** Counted from what is actually there, since another process may have written it. */
  stats(): CidStoreStats {
    const held = this.held();
    return {
      entries: held.length,
      bytes: held.reduce((total, entry) => total + entry.bytes, 0),
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      maxEntryBytes: this.maxEntryBytes,
      dir: this.dir,
    };
  }

  private held(): Entry[] {
    return this.backend.entries().sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  }

  /**
   * Drop the oldest entries until this one fits. The second check is an invariant, not a
   * branch that can fire: `put` has already refused anything over `maxEntryBytes`, which
   * is clamped to `maxBytes`, so an empty store always has room.
   */
  private makeRoom(held: Entry[], incoming: number): void {
    let bytes = held.reduce((total, entry) => total + entry.bytes, 0);
    let remaining = held.length;
    let evicted = 0;

    while (remaining > 0 && (bytes + incoming > this.maxBytes || remaining + 1 > this.maxEntries)) {
      const oldest = held[evicted]!;
      this.backend.remove(oldest.key);
      bytes -= oldest.bytes;
      remaining -= 1;
      evicted += 1;
    }
    if (bytes + incoming > this.maxBytes || remaining + 1 > this.maxEntries) {
      throw new StoreFullError(incoming, this.maxBytes);
    }
  }

  /** Strictly after every entry already held, so publication order survives coarse clocks. */
  private stamp(held: Entry[]): number {
    const newest = held.at(-1)?.at ?? 0;
    this.lastAt = Math.max(Date.now(), Math.floor(newest) + 1, this.lastAt + 1);
    return this.lastAt;
  }

  private cidOf(key: string): string {
    return cidFromDigest(key, this.cidVersion);
  }
}
