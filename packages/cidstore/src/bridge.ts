/**
 * The bridge between what a chain commits to and the bytes behind it.
 *
 * A trial stores two `bytes32`s. Those are keccak digests of the sponsor's spec and suite
 * text, so they name content without carrying any way to reach it, and a sha256 content id
 * cannot be derived from them. Meanwhile `submitRun` recovers the runner's address from a
 * signature and then throws the signature away, so a verifier arriving afterwards cannot
 * reproduce the digest the agent signed. The two halves of this file exist to close those
 * two gaps: a store that holds bytes under a content id, and a disclosure log that says
 * which bytes answered to which digest.
 *
 * The disclosure is never trusted, only used. Every read here re-hashes the bytes it got
 * and refuses if they do not answer to the cid the disclosure named, so a stale, poisoned
 * or hand-edited mapping surfaces as a mismatch rather than as a verdict built on someone
 * else's content.
 *
 * `digestOf` is injected rather than imported because this package deliberately has no
 * dependencies; `@crucible/smith`'s `digestOfContent` is the implementation callers pass.
 */

import { CidStore } from "./store.js";
import { DisclosureLog } from "./disclosure.js";
import { type Content } from "./cid.js";

export type DigestFn = (content: string | Uint8Array) => string;

export interface Pinned {
  /** the content id the bytes are stored under */
  cid: string;
  /** the digest a chain commits to — keccak over the same bytes */
  digest: string;
  bytes: number;
}

export class ContentUnverifiable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentUnverifiable";
  }
}

export interface ContentBridgeOptions {
  store: CidStore;
  disclosure: DisclosureLog;
  digestOf: DigestFn;
}

export class ContentBridge {
  constructor(private readonly opts: ContentBridgeOptions) {}

  /**
   * Pin spec or suite text and announce the digest it answers to.
   *
   * Order matters: the bytes go in the store first, so an announcement can never point at
   * content that is not there. A reader that found a mapping and no bytes would have to
   * abstain for the wrong reason.
   *
   * That sentence was a promise until 2026-10-25. `pinArtifact` below has always read the bytes
   * back before announcing them; this path — the one that commits a trial's spec and suite to an
   * on-chain digest — asserted the property in prose and never checked it. So a store that took
   * the write and lost it, or filed bytes under a CID that is not their content, left an
   * announcement pointing at nothing, and the digest published to the chain would name content no
   * cold verifier can fetch. The check is now the same one the artifact path makes, plus the
   * stronger half: re-derive the digest from what came back and refuse to announce a mapping
   * between two values that do not agree.
   */
  async pinContent(content: Content): Promise<Pinned> {
    const cid = this.opts.store.put(content);
    const digest = this.opts.digestOf(content);

    const back = this.opts.store.getBytes(cid);
    if (back === null) {
      throw new ContentUnverifiable(`content ${cid} was written and cannot be read back`);
    }
    const readBack = this.opts.digestOf(back);
    if (readBack !== digest) {
      throw new ContentUnverifiable(
        `content ${cid} reads back under ${readBack}, not the ${digest} about to be announced`,
      );
    }

    await this.opts.disclosure.announceSpec(digest, cid);
    return { cid, digest, bytes: byteLength(content) };
  }

  /**
   * Pin a run artifact and announce it under the run hash the chain recorded, with the two
   * fields the chain discarded.
   *
   * `signature` and `sigDeadline` are carried here because verification step 5 needs them
   * and nothing on-chain has them any more. Without this, the anti-fraud core of the
   * deterministic phase — recover the signer, compare to the registered runner key — is
   * unperformable by anyone but the submitter.
   *
   * `runHash` is a parameter, not recomputed here, on purpose: the chain's run hash is
   * keccak over the RFC 8785 canonicalization of the artifact, and a plain
   * keccak(JSON.stringify(artifact)) is a different value. Keying the disclosure by the
   * wrong one would make every lookup miss, and a verifier would report "no content behind
   * this commitment" about content that is sitting right there. The caller computes it with
   * `@crucible/smith`'s `computeRunHash`, the one function that defines the rule.
   */
  async pinArtifact(
    artifact: unknown,
    record: { runHash: string; signature: string; sigDeadline: string },
  ): Promise<Pinned> {
    const cid = this.opts.store.putJson(artifact);
    const raw = this.opts.store.get(cid);
    if (raw === null) {
      throw new ContentUnverifiable(`artifact ${cid} was written and cannot be read back`);
    }
    await this.opts.disclosure.announceArtifact(record.runHash, {
      cid,
      signature: record.signature,
      sigDeadline: record.sigDeadline,
    });
    return { cid, digest: record.runHash, bytes: byteLength(raw) };
  }

  /**
   * The full announcement for a run hash, or null when nobody ever made one.
   *
   * Refreshed first, every call. `DisclosureLog` caches its document in memory, so a
   * verifier process that came up before an agent submitted would otherwise answer "no
   * artifact" for a run that was announced a second ago and go on abstaining forever. The
   * file is small and a verification is not a hot loop; a stale pointer here is a wrong
   * verdict, not a stale render.
   */
  async artifactRecord(runHash: string) {
    await this.opts.disclosure.refresh();
    return this.opts.disclosure.artifactRecordFor(runHash);
  }

  /**
   * Fetch the bytes a chain digest names, and prove they are the bytes it meant.
   *
   * Throws rather than returning null on a mismatch: a verifier that read "no content"
   * where the truth is "the content does not match its own commitment" would abstain, and
   * an abstention on a poisoned disclosure is a pass for whoever poisoned it.
   */
  async contentForDigest(digest: string): Promise<string> {
    await this.opts.disclosure.refresh();
    const cid = this.opts.disclosure.specCidFor(digest);
    if (!cid) {
      throw new ContentUnverifiable(
        `nothing was ever announced for digest ${digest}, so the content behind this ` +
          `commitment cannot be checked. A trial whose digest was computed over something ` +
          `that was never pinned — for instance one built from abi.encodePacked(..., ` +
          `block.timestamp) — can never be resolved.`,
      );
    }
    // `store.get` re-hashes what it reads and refuses bytes that no longer answer to their
    // own name, so a tampered file surfaces here rather than as content.
    const text = this.opts.store.get(cid);
    if (text === null) {
      throw new ContentUnverifiable(
        `disclosure names ${cid} for digest ${digest}, but those bytes are not in the store`,
      );
    }
    return text;
  }

  /**
   * The text stored under a cid, or null when nothing answers to it.
   *
   * The store re-hashes on read, so a null here means "absent" and a returned string has
   * already been proved to hash to the name it was fetched by.
   */
  textForCid(cid: string): string | null {
    return this.opts.store.get(cid);
  }

  /**
   * Fetch and parse a run artifact by cid, checking the cid owns its bytes first.
   *
   * The store already re-hashes on read, so a truncated or edited artifact cannot reach the
   * deterministic phase as a plausible-looking object; this only adds the JSON parse and
   * turns a bad parse into the same refusal class rather than a raw SyntaxError.
   */
  async artifactForCid<T = unknown>(cid: string): Promise<T> {
    const raw = this.opts.store.get(cid);
    if (raw === null) {
      throw new ContentUnverifiable(`artifact ${cid} was announced but its bytes are not here`);
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new ContentUnverifiable(
        `artifact ${cid} is not valid JSON (${(err as Error).message})`,
      );
    }
  }
}

function byteLength(content: Content): number {
  // Bytes, not code units. `string.length` counts UTF-16 units, so a spec containing any
  // non-ASCII character would report a smaller size than the store holds — and this number
  // exists to reason about the store's byte ceiling, where being wrong in that direction is
  // the wrong direction.
  return typeof content === "string"
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;
}
