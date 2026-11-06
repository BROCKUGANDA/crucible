import { CidStore, DisclosureLog } from "@crucible/cidstore";
import { manifestDigest, type EvalManifest } from "@crucible/smith";
import type { Hex } from "viem";

/**
 * Publish the manifest a run was scored under, and point the disclosure at it.
 *
 * The manifest has existed all along: `buildRunManifest` computes it beside every artifact and
 * `manifestDigest` hashes it (ADR-0017 keeps it a separate hashed document rather than a field
 * of the artifact, because embedding it would change `computeRunHash` and invalidate every
 * signature). What was missing is anywhere for it to go. A verifier could re-derive the run
 * hash from the artifact and still not know which suite epoch, judge pin, tokenizer or sampling
 * settings produced the number — which is the whole question an evaluation record answers.
 *
 * So: pin the canonical JSON (the store's own `putJson`, the same serializer the digest was
 * taken over — two ways to write one document is two ways to get two CIDs for it), read it back
 * and re-hash it before announcing anything, then attach the pointer to the run's disclosure
 * record. The read-back check is not paranoia: announcing a CID that does not resolve to the
 * bytes the digest names is precisely the poisoned mapping this log exists to survive.
 */

export interface PublishedManifest {
  cid: string;
  digest: Hex;
}

export class ManifestPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestPublishError";
  }
}

export interface ManifestPublisherDeps {
  content: CidStore;
  disclosure: DisclosureLog;
}

export class ManifestPublisher {
  constructor(private readonly deps: ManifestPublisherDeps) {}

  /**
   * Pin `manifest`, prove the bytes came back as the same document, announce it for `runHash`.
   *
   * The manifest carries its own `chain`/`taskDigest` pins, but the digest this function
   * compares against is recomputed here rather than trusted from the caller: a publisher that
   * believed a passed-in digest would happily announce a CID and a number that disagree, and
   * every reader downstream would have to re-derive the lie themselves.
   */
  async publish(runHash: Hex, manifest: EvalManifest): Promise<PublishedManifest> {
    const digest = manifestDigest(manifest);
    const cid = this.deps.content.putJson(manifest);

    const readBack = this.deps.content.getJson<unknown>(cid);
    if (readBack === null) {
      throw new ManifestPublishError(`${cid} was written and cannot be read back`);
    }
    let roundTripped: Hex;
    try {
      roundTripped = manifestDigest(readBack as EvalManifest);
    } catch (err) {
      throw new ManifestPublishError(
        `${cid} did not parse back into a manifest the digest can be taken over: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (roundTripped.toLowerCase() !== digest.toLowerCase()) {
      throw new ManifestPublishError(
        `${cid} hashes to ${roundTripped}, not the ${digest} this run reported`,
      );
    }

    await this.deps.disclosure.announceManifest(runHash, { cid, digest });
    return { cid, digest };
  }
}
