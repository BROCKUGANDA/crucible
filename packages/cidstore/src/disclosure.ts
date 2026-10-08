/**
 * Linking an on-chain commitment to the content that answers to it.
 *
 * The chain stores a digest, never a locator: `submitRun` records `runHash` (keccak over
 * the canonicalized artifact) and `postTrial` records the sponsor's spec and tests
 * digests. A sha256 content id cannot be derived from a keccak digest, so the process that
 * *made* the content has to announce which bytes it corresponds to. That is what this file
 * is: a small, append-only announcement both sides can read.
 *
 * It is deliberately not a source of truth. Every entry is checkable — a verifier
 * re-canonicalizes the bytes it fetches and recomputes the run hash, so a poisoned or
 * stale mapping is reported as a mismatch rather than trusted. The disclosure says where
 * to look; the artifact's own hash says whether to believe it.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * What a runner must announce about a run so it can be verified later.
 *
 * `signature` and `sigDeadline` are here because the chain throws them away: `submitRun`
 * recovers the signer, checks it against the registered runner key, and keeps only the
 * digest. A verifier arriving afterwards cannot recover a signature it was never shown, so
 * the bytes have to come from the party that held them.
 */
export interface RunRecord {
  /** sha256 content id of the artifact JSON whose keccak(JCS(·)) is the run hash */
  cid: string;
  signature?: string;
  sigDeadline?: string;
}

/** runHash (0x-prefixed keccak hex) -> what the runner published behind it */
export type ArtifactMap = Record<string, RunRecord>;

/** specDigest / testsDigest -> the CID of the text that hashes to it */
export type SpecMap = Record<string, string>;

export interface Disclosure {
  schemaVersion: 1;
  artifacts: ArtifactMap;
  specs: SpecMap;
}

const EMPTY: Disclosure = { schemaVersion: 1, artifacts: {}, specs: {} };

export class DisclosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisclosureError";
  }
}

/**
 * A file-backed disclosure.
 *
 * Writes go through a temp file and `rename`, which is atomic on both POSIX and Windows:
 * two services read the same directory, and a reader that caught a half-written JSON
 * document would see a trial with no artifact and abstain for the wrong reason.
 */
export class DisclosureLog {
  private constructor(
    private readonly file: string,
    private data: Disclosure,
  ) {}

  static async open(dir: string): Promise<DisclosureLog> {
    const file = path.join(dir, "disclosure.json");
    await mkdir(dir, { recursive: true });
    if (!existsSync(file)) return new DisclosureLog(file, fresh());

    const raw = await readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // A corrupt disclosure is a real operational fault, not a nuisance: silently
      // starting over would drop every artifact pointer and make every in-flight dispute
      // unverifiable. Fail with the file named so it can be restored.
      throw new DisclosureError(
        `${file} is not valid JSON (${(err as Error).message}) — restore it or delete it deliberately`,
      );
    }
    return new DisclosureLog(file, normalize(parsed));
  }

  /** Announce the artifact behind a run hash. Idempotent. */
  async announceArtifact(runHash: string, record: RunRecord | string): Promise<void> {
    const value: RunRecord = typeof record === "string" ? { cid: record } : record;
    const key = runHash.toLowerCase();
    const existing = this.data.artifacts[key];
    if (existing && sameRecord(existing, value)) return;
    this.data.artifacts[key] = value;
    await this.flush();
  }

  /** Announce the text behind a sponsor's spec or tests digest. Idempotent. */
  async announceSpec(digest: string, cid: string): Promise<void> {
    const key = digest.toLowerCase();
    if (this.data.specs[key] === cid) return;
    this.data.specs[key] = cid;
    await this.flush();
  }

  /** The full announcement — a verifier needs the signature the chain discarded. */
  artifactRecordFor(runHash: string): RunRecord | undefined {
    return this.data.artifacts[runHash.toLowerCase()];
  }

  artifactCidFor(runHash: string): string | undefined {
    return this.data.artifacts[runHash.toLowerCase()]?.cid;
  }

  specCidFor(digest: string): string | undefined {
    return this.data.specs[digest.toLowerCase()];
  }

  get size(): { artifacts: number; specs: number } {
    return {
      artifacts: Object.keys(this.data.artifacts).length,
      specs: Object.keys(this.data.specs).length,
    };
  }

  /** Re-read from disk so a reader sees another process's announcements. */
  async refresh(): Promise<void> {
    if (!existsSync(this.file)) {
      this.data = fresh();
      return;
    }
    this.data = normalize(JSON.parse(await readFile(this.file, "utf8")));
  }

  private async flush(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}

function fresh(): Disclosure {
  return { schemaVersion: 1, artifacts: {}, specs: {} };
}

function sameRecord(a: RunRecord, b: RunRecord): boolean {
  return a.cid === b.cid && a.signature === b.signature && a.sigDeadline === b.sigDeadline;
}

function normalize(parsed: unknown): Disclosure {
  if (!parsed || typeof parsed !== "object") {
    throw new DisclosureError("disclosure must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== 1) {
    // Accepting an unknown shape and carrying on is how a format change turns into
    // "no artifacts found" three services later.
    throw new DisclosureError(`unsupported disclosure schemaVersion: ${String(o.schemaVersion)}`);
  }
  return {
    schemaVersion: 1,
    artifacts: asRecords(o.artifacts),
    specs: asStrings(o.specs),
  };
}

/**
 * Readers accept both the record form and a bare cid string.
 *
 * Not a compatibility shim for its own sake: a disclosure written by a hand-run script
 * announcing just a cid is legitimate input, and refusing it would throw away an
 * announcement that is actually usable for everything except the signature step.
 */
function asRecords(value: unknown): ArtifactMap {
  const out: ArtifactMap = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = { cid: v };
    else if (v && typeof v === "object" && typeof (v as { cid?: unknown }).cid === "string") {
      const r = v as RunRecord;
      out[k.toLowerCase()] = { cid: r.cid, ...(r.signature ? { signature: r.signature } : {}), ...(r.sigDeadline ? { sigDeadline: r.sigDeadline } : {}) };
    }
  }
  return out;
}

function asStrings(value: unknown): SpecMap {
  const out: SpecMap = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}
