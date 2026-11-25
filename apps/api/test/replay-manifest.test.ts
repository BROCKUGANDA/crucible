import { describe, it, expect, beforeEach } from "vitest";
import { REQUIRED_REPLAYS } from "../src/replay-policy.js";
import {
  createReplayManifest,
  getReplayManifest,
  listManifestsByTrial,
  listManifestsByRun,
  createReplayRecord,
  completeReplay,
  failReplay,
  getReplayRecord,
  listReplaysByManifest,
  isVerified,
  resetReplayStore,
} from "../src/replay-manifest.js";

describe("replay-manifest", () => {
  beforeEach(async () => {
    await resetReplayStore();
  });

  const validManifestInput = {
    trialId: "trial-1",
    runId: "run-1",
    specDigest: "abc123",
    suiteVersion: "1",
    agentId: "agent-1",
    runtimeImageDigest: "sha256:xyz",
    executionConfig: {},
    judgeVersion: "1",
    environmentFingerprint: "env-1",
    artifactHashes: {},
    workerIdentity: "worker-1",
  };

  describe("createReplayManifest", () => {
    it("creates a manifest with all required fields", async () => {
      const manifest = await createReplayManifest(validManifestInput);
      expect(manifest.manifestId).toBeDefined();
      expect(manifest.trialId).toBe("trial-1");
      expect(manifest.status).toBe("PENDING");
      expect(manifest.reproducibilityState).toBe("PENDING");
    });

    it("rejects missing trialId", async () => {
      await expect(
        createReplayManifest({ ...validManifestInput, trialId: "" }),
      ).rejects.toThrow("trialId is required");
    });

    it("rejects missing runtimeImageDigest", async () => {
      await expect(
        createReplayManifest({ ...validManifestInput, runtimeImageDigest: "" }),
      ).rejects.toThrow("runtimeImageDigest is required");
    });

    it("returns manifest via getReplayManifest", async () => {
      const manifest = await createReplayManifest(validManifestInput);
      const found = await getReplayManifest(manifest.manifestId);
      expect(found).toEqual(manifest);
    });
  });

  describe("listManifestsByTrial", () => {
    it("lists manifests by trial", async () => {
      await createReplayManifest(validManifestInput);
      await createReplayManifest({ ...validManifestInput, runId: "run-2" });
      await createReplayManifest({ ...validManifestInput, trialId: "trial-2" });

      expect((await listManifestsByTrial("trial-1")).length).toBe(2);
      expect((await listManifestsByTrial("trial-2")).length).toBe(1);
    });
  });

  describe("listManifestsByRun", () => {
    it("lists manifests by run", async () => {
      await createReplayManifest(validManifestInput);
      await createReplayManifest({ ...validManifestInput, runId: "run-2" });

      expect((await listManifestsByRun("run-1")).length).toBe(1);
      expect((await listManifestsByRun("run-2")).length).toBe(1);
    });
  });

  describe("createReplayRecord", () => {
    it("creates a replay record", async () => {
      const manifest = await createReplayManifest(validManifestInput);
      const record = await createReplayRecord(manifest.manifestId, 1, "worker-1");

      expect(record.replayId).toBeDefined();
      expect(record.replayNumber).toBe(1);
      expect(record.status).toBe("PENDING");
    });

    it("rejects unknown manifest", async () => {
      await expect(createReplayRecord("nonexistent", 1, "worker-1")).rejects.toThrow("not found");
    });

    it("rejects invalid replay number", async () => {
      const manifest = await createReplayManifest(validManifestInput);
      await expect(
        createReplayRecord(manifest.manifestId, 4, "worker-1"),
      ).rejects.toThrow(`must be 1, ${REQUIRED_REPLAYS}`);
    });

    it("rejects duplicate replay number", async () => {
      const manifest = await createReplayManifest(validManifestInput);
      await createReplayRecord(manifest.manifestId, 1, "worker-1");

      await expect(
        createReplayRecord(manifest.manifestId, 1, "worker-2"),
      ).rejects.toThrow("already exists");
    });
  });

  describe("completeReplay", () => {
    it("completes a replay", async () => {
      const manifest = await createReplayManifest(validManifestInput);
      const record = await createReplayRecord(manifest.manifestId, 1, "worker-1");

      const completed = await completeReplay(record.replayId, "hash123");
      expect(completed.status).toBe("COMPLETED");
      expect(completed.outputHash).toBe("hash123");
      expect(completed.finishTimestamp).toBeDefined();
    });

    it("rejects unknown replay", async () => {
      await expect(completeReplay("nonexistent", "hash123")).rejects.toThrow("not found");
    });
  });

  describe("failReplay", () => {
    it("fails a replay", async () => {
      const manifest = await createReplayManifest(validManifestInput);
      const record = await createReplayRecord(manifest.manifestId, 1, "worker-1");

      const failed = await failReplay(record.replayId, "timeout");
      expect(failed.status).toBe("FAILED");
      expect(failed.differences).toEqual({ reason: "timeout" });
    });
  });

  describe("reproducibility state", () => {
    it("marks REPRODUCIBLE when 3 replays agree", async () => {
      const manifest = await createReplayManifest(validManifestInput);

      const r1 = await createReplayRecord(manifest.manifestId, 1, "worker-1");
      const r2 = await createReplayRecord(manifest.manifestId, 2, "worker-2");
      const r3 = await createReplayRecord(manifest.manifestId, 3, "worker-3");

      await completeReplay(r1.replayId, "same-hash");
      await completeReplay(r2.replayId, "same-hash");
      await completeReplay(r3.replayId, "same-hash");

      expect(await isVerified(manifest.manifestId)).toBe(true);
      expect((await getReplayManifest(manifest.manifestId))?.reproducibilityState).toBe("REPRODUCIBLE");
    });

    it("does NOT call it reproducible when the replays agree but came from ONE worker", async () => {
      // The rule is about independence. One worker running the same
      // verifier three times can agree three times and still be wrong
      // three times — a sticky seed, a cached artefact, a bug in that
      // worker. Agreement is not the rule; independent agreement is.
      const manifest = await createReplayManifest(validManifestInput);

      const r1 = await createReplayRecord(manifest.manifestId, 1, "worker-1");
      const r2 = await createReplayRecord(manifest.manifestId, 2, "worker-1");
      const r3 = await createReplayRecord(manifest.manifestId, 3, "worker-1");

      await completeReplay(r1.replayId, "same-hash");
      await completeReplay(r2.replayId, "same-hash");
      await completeReplay(r3.replayId, "same-hash");

      expect(await isVerified(manifest.manifestId)).toBe(false);
      const found = await getReplayManifest(manifest.manifestId);
      expect(found?.reproducibilityState).toBe("INCONCLUSIVE");
      expect(found?.reproducibilityNote).toContain("1 worker");
    });

    it("does NOT call it reproducible when the replays came from only two workers", async () => {
      const manifest = await createReplayManifest(validManifestInput);

      const r1 = await createReplayRecord(manifest.manifestId, 1, "worker-1");
      const r2 = await createReplayRecord(manifest.manifestId, 2, "worker-1");
      const r3 = await createReplayRecord(manifest.manifestId, 3, "worker-2");

      await completeReplay(r1.replayId, "same-hash");
      await completeReplay(r2.replayId, "same-hash");
      await completeReplay(r3.replayId, "same-hash");

      expect(await isVerified(manifest.manifestId)).toBe(false);
      expect((await getReplayManifest(manifest.manifestId))?.reproducibilityNote).toContain("2 workers");
    });

    it("counts the WORKERS, not the labels the caller chose", async () => {
      // Three replays labelled "worker-a", "worker-b" and "worker-c" are
      // one worker with three names. The labels are kept and shown; they
      // are never what the rule is decided on.
      const manifest = await createReplayManifest(validManifestInput);

      const r1 = await createReplayRecord(manifest.manifestId, 1, "worker-1", "worker-a");
      const r2 = await createReplayRecord(manifest.manifestId, 2, "worker-1", "worker-b");
      const r3 = await createReplayRecord(manifest.manifestId, 3, "worker-1", "worker-c");

      await completeReplay(r1.replayId, "same-hash");
      await completeReplay(r2.replayId, "same-hash");
      await completeReplay(r3.replayId, "same-hash");

      expect(await isVerified(manifest.manifestId)).toBe(false);
      expect((await listReplaysByManifest(manifest.manifestId)).map((r) => r.label)).toEqual([
        "worker-a",
        "worker-b",
        "worker-c",
      ]);
    });

    it("marks INCONCLUSIVE when 3 replays disagree", async () => {
      const manifest = await createReplayManifest(validManifestInput);

      const r1 = await createReplayRecord(manifest.manifestId, 1, "worker-1");
      const r2 = await createReplayRecord(manifest.manifestId, 2, "worker-2");
      const r3 = await createReplayRecord(manifest.manifestId, 3, "worker-3");

      await completeReplay(r1.replayId, "hash-1");
      await completeReplay(r2.replayId, "hash-2");
      await completeReplay(r3.replayId, "hash-3");

      expect(await isVerified(manifest.manifestId)).toBe(false);
      expect((await getReplayManifest(manifest.manifestId))?.reproducibilityState).toBe("INCONCLUSIVE");
    });

    it("marks PENDING when fewer than 3 replays complete", async () => {
      const manifest = await createReplayManifest(validManifestInput);

      const r1 = await createReplayRecord(manifest.manifestId, 1, "worker-1");
      await completeReplay(r1.replayId, "hash-1");

      expect(await isVerified(manifest.manifestId)).toBe(false);
      expect((await getReplayManifest(manifest.manifestId))?.reproducibilityState).toBe("PENDING");
    });

    it("marks FAILED when all replays fail", async () => {
      const manifest = await createReplayManifest(validManifestInput);

      const r1 = await createReplayRecord(manifest.manifestId, 1, "worker-1");
      await failReplay(r1.replayId, "error");

      expect((await getReplayManifest(manifest.manifestId))?.reproducibilityState).toBe("FAILED");
    });
  });

  describe("listReplaysByManifest", () => {
    it("lists replays sorted by number", async () => {
      const manifest = await createReplayManifest(validManifestInput);

      await createReplayRecord(manifest.manifestId, 3, "worker-3");
      await createReplayRecord(manifest.manifestId, 1, "worker-1");
      await createReplayRecord(manifest.manifestId, 2, "worker-2");

      const replays = await listReplaysByManifest(manifest.manifestId);
      expect(replays[0].replayNumber).toBe(1);
      expect(replays[1].replayNumber).toBe(2);
      expect(replays[2].replayNumber).toBe(3);
    });
  });
});
