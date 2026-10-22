import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "json-canonicalize";
import { keccak256, stringToHex, type Hex } from "viem";

/**
 * The trace spine: an append-only, hash-chained record of what the protocol did.
 *
 * Every entry links to the one before it by hash, so a record cannot be edited, inserted
 * into, or reordered without breaking the link at that point. That property is why this is
 * worth having at all: the showcase that reads it is supposed to be evidence, and evidence
 * that a reader cannot check is just a dashboard.
 *
 * What it is NOT:
 *
 *   - **Not a source of truth.** The chain is. This is a projection of things the chain
 *     already decided, plus the off-chain steps leading to them (a keeper's action, a
 *     breaker trip). If the trace disagrees with the chain, the chain is right.
 *   - **Not a security boundary by itself.** Hash-chaining detects tampering with the
 *     *contents* of an entry and its position. It cannot detect that a valid suffix was cut
 *     off — a truncated chain is still a valid chain. Anchoring the head somewhere the
 *     author does not control is what would close that, and nothing does that yet.
 *   - **Not a place for secrets or personal data.** Spans carry ids and counts. Addresses
 *     are public chain data; keys, signatures over unseen payloads, and anything a person
 *     typed are not. `assertJsonSafe` keeps the shape honest but cannot judge sensitivity.
 *
 * The hashing rule is deliberately the same one the run artifact uses — keccak over RFC
 * 8785 canonical JSON — so a trace entry and a run hash mean the same thing by "the same
 * bytes", and there is one canonicalization convention in the tree rather than two.
 */

export type TraceDetail = Record<string, unknown> | string;

/** An entry before it is chained and sealed. */
export interface TraceSpan {
  /** unix milliseconds; part of the hash, so a rewritten clock breaks the chain */
  ts: number;
  /** dotted name, e.g. `keeper.act` — a namespace, not a sentence */
  span: string;
  /** the trial this belongs to, when there is one; the trace id the protocol already has */
  trialId?: number;
  /** who produced the span: `keeper`, `seat`, `api` */
  actor?: string;
  detail?: TraceDetail;
}

export interface SealedSpan extends TraceSpan {
  /** the previous entry's hash, or 32 zero bytes for the first entry */
  prevHash: Hex;
  /** keccak256 over the canonical JSON of this entry without `hash` */
  hash: Hex;
}

export type VerifyResult =
  | { ok: true; entries: number; head: Hex }
  | { ok: false; index: number; reason: string };

export class TraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceError";
  }
}

export const GENESIS: Hex = `0x${"00".repeat(32)}`;

function seal(span: TraceSpan, prevHash: Hex): SealedSpan {
  // Absent detail is fine — most spans are just "this happened to this trial". It is a
  // detail that exists and still cannot round-trip through JSON that is the problem.
  if (span.detail !== undefined) assertJsonSafe(span.detail);
  const body = { ...span, prevHash };
  const hash = keccak256(stringToHex(canonicalize(body)));
  return { ...body, hash };
}

function hashOf(entry: SealedSpan): Hex {
  const { hash: _hash, ...body } = entry;
  return keccak256(stringToHex(canonicalize(body)));
}

/**
 * Rejects anything that JSON would quietly change on the way in.
 *
 * A trace is only evidence if a reader can recompute what the writer hashed. `bigint`
 * throws in JSON.stringify, `undefined` disappears from objects, and `NaN`/`Infinity`
 * become `null` — so a span carrying any of them would either crash at the wrong layer or
 * seal a digest over bytes that do not match what the caller thought it recorded. Failing
 * here, by name and path, is the difference between a bug that surfaces and a record that
 * is subtly false.
 */
function assertJsonSafe(value: unknown, at = "detail"): void {
  if (value === null) return;
  if (value === undefined) throw new TraceError(`${at} is undefined; traces carry JSON only`);
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TraceError(`${at} is ${String(value)}; only finite numbers are representable`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSafe(item, `${at}[${i}]`));
    return;
  }
  if (kind === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(item, `${at}.${key}`);
    }
    return;
  }
  throw new TraceError(
    `${at} is a ${kind}; convert it to a JSON type first (bigints become decimal strings, ` +
      `which is also how the API publishes wei)`,
  );
}

export interface TraceLogOptions {
  /** Clock, injectable so a test can pin the timestamp that goes into the hash. */
  now?: () => number;
}

/**
 * A trace file, opened for appending.
 *
 * One instance per process; appends are serialized through an internal promise chain so
 * two concurrent callers cannot interleave a chain link. The protocol is serial by design,
 * but a busier caller — a keeper acting while a request handler records — would fork the
 * chain, and a forked chain verifies as broken with no indication that the writer was at
 * fault rather than an attacker.
 */
export class TraceLog {
  private tail: Promise<unknown> = Promise.resolve();
  private lastHash: Hex;
  private count: number;
  /** Entries kept when there is no file, so `read()` and `verify()` are not files-only. */
  private readonly kept: SealedSpan[];

  private constructor(
    private readonly file: string,
    entries: SealedSpan[],
    private readonly opts: TraceLogOptions,
  ) {
    this.count = entries.length;
    this.lastHash = entries.length ? entries[entries.length - 1]!.hash : GENESIS;
    this.kept = [...entries];
  }

  /**
   * Opens (or creates) a trace file and picks up its chain.
   *
   * An existing chain is verified before it is extended. Appending to a chain that is
   * already broken would launder the break: the new entries would be valid in themselves,
   * and a later verification would report the original tampering at an old index while the
   * writer's own additions looked clean.
   */
  static async open(file: string, opts: TraceLogOptions = {}): Promise<TraceLog> {
    await mkdir(path.dirname(file), { recursive: true });
    const entries = await readEntries(file);
    if (entries.length) {
      const check = verifyEntries(entries);
      if (!check.ok) {
        throw new TraceError(
          `${file} does not verify (entry ${check.index}: ${check.reason}). Refusing to ` +
            `append to a broken chain — restore or rotate it deliberately.`,
        );
      }
    }
    return new TraceLog(file, entries, opts);
  }

  /** In-memory only. For tests and for a process that has nowhere to write. */
  static memory(opts: TraceLogOptions = {}): TraceLog {
    return new TraceLog("", [], opts);
  }

  get size(): number {
    return this.count;
  }

  get head(): Hex {
    return this.lastHash;
  }

  /**
   * Appends one span and returns it sealed.
   *
   * The returned entry is what a caller may publish; it carries its own hash and the
   * previous one, so a reader does not need this process to check it.
   */
  append(span: TraceSpan): Promise<SealedSpan> {
    const run = async (): Promise<SealedSpan> => {
      const sealed = seal(span, this.lastHash);
      if (this.file) {
        // A single line write. `appendFile` opens with O_APPEND, so the kernel places it at
        // the end even if another process appended first — but the hash above was computed
        // against OUR last hash, which is why two writers are not supported and the
        // single-instance assumption is documented rather than assumed.
        await appendFile(this.file, `${JSON.stringify(sealed)}\n`, "utf8");
      }
      this.lastHash = sealed.hash;
      this.count += 1;
      if (!this.file) this.kept.push(sealed);
      return sealed;
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Convenience: stamp the span with the configured clock. */
  appendNow(span: Omit<TraceSpan, "ts"> & { ts?: number }): Promise<SealedSpan> {
    const ts = span.ts ?? (this.opts.now ?? Date.now)();
    return this.append({ ...span, ts });
  }

  /** Reads and verifies the whole chain. */
  async verify(): Promise<VerifyResult> {
    return verifyEntries(this.file ? await readEntries(this.file) : this.kept);
  }

  async read(): Promise<SealedSpan[]> {
    return this.file ? readEntries(this.file) : [...this.kept];
  }
}

async function readEntries(file: string): Promise<SealedSpan[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: SealedSpan[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as SealedSpan);
    } catch (err) {
      // A partial final line is the normal shape of a write interrupted by a crash. It is
      // still a broken chain, but the message should say which, because "the last line is
      // garbage" is a very different operational fact from "someone edited entry 12".
      throw new TraceError(
        `${file}: line ${i + 1} is not valid JSON (${(err as Error).message}). ` +
          `${i + 1 === lines.length ? "This is the shape of a write cut off by a crash." : "This is not the last line."}`,
      );
    }
  }
  return entries;
}

/**
 * Recomputes the chain.
 *
 * Reports the FIRST broken link and stops, because later entries are all suspect once one
 * fails and a list of cascading errors hides the one that matters.
 */
export function verifyEntries(entries: SealedSpan[]): VerifyResult {
  let prev: Hex = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.prevHash !== prev) {
      return {
        ok: false,
        index: i,
        reason: `prevHash does not follow the previous entry's hash (expected ${prev}, found ${entry.prevHash})`,
      };
    }
    const recomputed = hashOf(entry);
    if (recomputed !== entry.hash) {
      return {
        ok: false,
        index: i,
        reason: `contents do not hash to the recorded hash (recomputed ${recomputed}, recorded ${entry.hash})`,
      };
    }
    prev = entry.hash;
  }
  return { ok: true, entries: entries.length, head: prev };
}
