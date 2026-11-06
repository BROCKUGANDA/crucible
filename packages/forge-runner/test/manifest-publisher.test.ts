import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CidStore, DisclosureError, DisclosureLog, isCid } from "@crucible/cidstore";
import { buildEvalManifest, manifestDigest, type EvalManifest } from "@crucible/smith";
import type { Hex } from "viem";
import { ManifestPublishError, ManifestPublisher } from "../src/manifest-publisher.js";

const TASK = `0x${"11".repeat(32)}` as Hex;
const SUITE = `0x${"22".repeat(32)}` as Hex;
const RUN = `0x${"9c".repeat(32)}` as Hex;

function manifest(over: Partial<EvalManifest> = {}): EvalManifest {
  return buildEvalManifest({
    taskDigest: TASK,
    suiteDigest: SUITE,
    evaluator: { id: "argus", version: "1.4.0", rubricVersion: "3" },
    model: { provider: "hetzner", name: "qwen", version: "Qwen/Qwen3.6-35B-A3B" },
    environment: { imageDigest: `crucible/verifier@sha256:${"a".repeat(64)}` },
    seed: "panel-2026-10-27",
    scoring: {
      feeSchedule: "legacy-v1",
      feeScheduleVersion: "1",
      decision: "deterministic-suite",
    },
    startedAt: "2026-10-27T12:00:00.000Z",
    finishedAt: "2026-10-27T12:00:41.000Z",
    ...over,
  }) as EvalManifest;
}

async function workspace(): Promise<{
  content: CidStore;
  disclosure: DisclosureLog;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "crucible-manifest-publish-"));
  const content = new CidStore({ dir: join(dir, "content") });
  const disclosure = await DisclosureLog.open(dir);
  return {
    content,
    disclosure,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("publishing a run's manifest", () => {
  it("pins the document, and the pinned bytes re-hash to the digest it reports", async () => {
    const { content, disclosure, cleanup } = await workspace();
    try {
      await disclosure.announceArtifact(RUN, "bafy-artifact");
      const doc = manifest();
      const published = await new ManifestPublisher({ content, disclosure }).publish(RUN, doc);

      expect(published.digest).toBe(manifestDigest(doc));
      // The store's own predicate, not a prefix guess: a CIDv1 raw pin starts `bafk…` and a
      // dag-pb one starts `bafy…`, and an assertion written from memory would have failed on
      // whichever the store happens to use.
      expect(isCid(published.cid)).toBe(true);
      const fetched = content.getJson<EvalManifest>(published.cid);
      expect(manifestDigest(fetched!)).toBe(published.digest);
    } finally {
      await cleanup();
    }
  });

  it("announces the pointer onto the run's existing record", async () => {
    const { content, disclosure, cleanup } = await workspace();
    try {
      await disclosure.announceArtifact(RUN, { cid: "bafy-artifact", signature: "0xsig", sigDeadline: "1800" });
      const published = await new ManifestPublisher({ content, disclosure }).publish(RUN, manifest());

      const record = disclosure.artifactRecordFor(RUN);
      expect(record?.cid).toBe("bafy-artifact");
      expect(record?.signature).toBe("0xsig");
      expect(record?.manifestCid).toBe(published.cid);
      expect(record?.manifestDigest).toBe(published.digest);
    } finally {
      await cleanup();
    }
  });

  /**
   * The reason the publisher is its own module instead of one line in the runner.
   *
   * Announcing a CID before proving the bytes behind it re-hash would write a pointer that
   * every later reader trusts and nobody can resolve — the poisoned-mapping failure the
   * disclosure format was built to survive. So the read-back runs first, and a store that
   * answers with anything else is refused with the mismatch named.
   */
  it("refuses to announce a CID whose bytes do not hash to the manifest it was given", async () => {
    const { disclosure, cleanup } = await workspace();
    try {
      await disclosure.announceArtifact(RUN, "bafy-artifact");
      const lying = {
        putJson: () => "bafy-lying",
        getJson: () => ({ not: "a manifest" }),
      } as unknown as CidStore;

      await expect(new ManifestPublisher({ content: lying, disclosure }).publish(RUN, manifest())).rejects.toThrow(
        ManifestPublishError,
      );
      expect(disclosure.artifactRecordFor(RUN)?.manifestCid).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("refuses a store that cannot read back what it just wrote", async () => {
    const { disclosure, cleanup } = await workspace();
    try {
      await disclosure.announceArtifact(RUN, "bafy-artifact");
      const gone = { putJson: () => "bafy-x", getJson: () => null } as unknown as CidStore;
      await expect(
        new ManifestPublisher({ content: gone, disclosure }).publish(RUN, manifest()),
      ).rejects.toThrow(/cannot be read back/);
    } finally {
      await cleanup();
    }
  });

  it("refuses a run that was never announced, rather than documenting a run that never happened", async () => {
    const { content, disclosure, cleanup } = await workspace();
    try {
      await expect(
        new ManifestPublisher({ content, disclosure }).publish(RUN, manifest()),
      ).rejects.toThrow(DisclosureError);
    } finally {
      await cleanup();
    }
  });

  it("is idempotent: the same manifest hashes, pins and announces once", async () => {
    const { content, disclosure, cleanup } = await workspace();
    try {
      await disclosure.announceArtifact(RUN, "bafy-artifact");
      const publisher = new ManifestPublisher({ content, disclosure });
      const doc = manifest();
      const first = await publisher.publish(RUN, doc);
      const second = await publisher.publish(RUN, doc);

      expect(second).toEqual(first);
      expect(content.list().filter((cid) => cid === first.cid)).toHaveLength(1);
      expect(disclosure.artifactRecordFor(RUN)?.manifestCid).toBe(first.cid);
    } finally {
      await cleanup();
    }
  });
});
