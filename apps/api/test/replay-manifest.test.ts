import { describe, it, expect, beforeEach } from "vitest";
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
  beforeEach(() => {
    resetReplayStore();
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
    it("creates a manifest with all required fields", () => {
      const manifest = createReplayManifest(validManifestInput);
      expect(manifest.manifestId).toBeDefined();
      expect(manifest.trialId).toBe("trial-1");
      expect(manifest.status).toBe("PENDING");
      expect(manifest.reproducibilityState).toBe("PENDING");
    });

    it("rejects missing trialId", () => {
      expect(() =>
        createReplayManifest({ ...validManifestInput, trialId: "" }),
      ).toThrow("trialId is required");
    });

    it("rejects missing runtimeImageDigest", () => {
      expect(() =>
        createReplayManifest({ ...validManifestInput, runtimeImageDigest: "" }),
      ).toThrow("runtimeImageDigest is required");
    });

    it("returns manifest via getReplayManifest", () => {
      const manifest = createReplayManifest(validManifestInput);
      const found = getReplayManifest(manifest.manifestId);
      expect(found).toEqual(manifest);
    });
  });

  describe("listManifestsByTrial", () => {
    it("lists manifests by trial", () => {
      createReplayManifest(validManifestInput);
      createReplayManifest({ ...validManifestInput, runId: "run-2" });
      createReplayManifest({ ...validManifestInput, trialId: "trial-2" });

      expect(listManifestsByTrial("trial-1").length).toBe(2);
      expect(listManifestsByTrial("trial-2").length).toBe(1);
    });
  });

  describe("listManifestsByRun", () => {
    it("lists manifests by run", () => {
      createReplayManifest(validManifestInput);
      createReplayManifest({ ...validManifestInput, runId: "run-2" });

      expect(listManifestsByRun("run-1").length).toBe(1);
      expect(listManifestsByRun("run-2").length).toBe(1);
    });
  });

  describe("createReplayRecord", () => {
    it("creates a replay record", () => {
      const manifest = createReplayManifest(validManifestInput);
      const record = createReplayRecord(manifest.manifestId, 1, "worker-1");

      expect(record.replayId).toBeDefined();
      expect(record.replayNumber).toBe(1);
      expect(record.status).toBe("PENDING");
    });

    it("rejects unknown manifest", () => {
      expect(() =>
        createReplayRecord("nonexistent", 1, "worker-1"),
      ).toThrow("not found");
    });

    it("rejects invalid replay number", () => {
      const manifest = createReplayManifest(validManifestInput);
      expect(() =>
        createReplayRecord(manifest.manifestId, 4, "worker-1"),
      ).toThrow("must be 1, 2, or 3");
    });

    it("rejects duplicate replay number", () => {
      const manifest = createReplayManifest(validManifestInput);
      createReplayRecord(manifest.manifestId, 1, "worker-1");

      expect(() =>
        createReplayRecord(manifest.manifestId, 1, "worker-2"),
      ).toThrow("already exists");
    });
  });

  describe("completeReplay", () => {
    it("completes a replay", () => {
      const manifest = createReplayManifest(validManifestInput);
      const record = createReplayRecord(manifest.manifestId, 1, "worker-1");

      const completed = completeReplay(record.replayId, "hash123");
      expect(completed.status).toBe("COMPLETED");
      expect(completed.outputHash).toBe("hash123");
      expect(completed.finishTimestamp).toBeDefined();
    });

    it("rejects unknown replay", () => {
      expect(() => completeReplay("nonexistent", "hash123")).toThrow("not found");
    });
  });

  describe("failReplay", () => {
    it("fails a replay", () => {
      const manifest = createReplayManifest(validManifestInput);
      const record = createReplayRecord(manifest.manifestId, 1, "worker-1");

      const failed = failReplay(record.replayId, "timeout");
      expect(failed.status).toBe("FAILED");
      expect(failed.differences).toEqual({ reason: "timeout" });
    });
  });

  describe("reproducibility state", () => {
    it("marks REPRODUCIBLE when 3 replays agree", () => {
      const manifest = createReplayManifest(validManifestInput);

      const r1 = createReplayRecord(manifest.manifestId, 1, "worker-1");
      const r2 = createReplayRecord(manifest.manifestId, 2, "worker-2");
      const r3 = createReplayRecord(manifest.manifestId, 3, "worker-3");

      completeReplay(r1.replayId, "same-hash");
      completeReplay(r2.replayId, "same-hash");
      completeReplay(r3.replayId, "same-hash");

      expect(isVerified(manifest.manifestId)).toBe(true);
      expect(getReplayManifest(manifest.manifestId)?.reproducibilityState).toBe("REPRODUCIBLE");
    });

    it("marks INCONCLUSIVE when 3 replays disagree", () => {
      const manifest = createReplayManifest(validManifestInput);

      const r1 = createReplayRecord(manifest.manifestId, 1, "worker-1");
      const r2 = createReplayRecord(manifest.manifestId, 2, "worker-2");
      const r3 = createReplayRecord(manifest.manifestId, 3, "worker-3");

      completeReplay(r1.replayId, "hash-1");
      completeReplay(r2.replayId, "hash-2");
      completeReplay(r3.replayId, "hash-3");

      expect(isVerified(manifest.manifestId)).toBe(false);
      expect(getReplayManifest(manifest.manifestId)?.reproducibilityState).toBe("INCONCLUSIVE");
    });

    it("marks PENDING when fewer than 3 replays complete", () => {
      const manifest = createReplayManifest(validManifestInput);

      const r1 = createReplayRecord(manifest.manifestId, 1, "worker-1");
      completeReplay(r1.replayId, "hash-1");

      expect(isVerified(manifest.manifestId)).toBe(false);
      expect(getReplayManifest(manifest.manifestId)?.reproducibilityState).toBe("PENDING");
    });

    it("marks FAILED when all replays fail", () => {
      const manifest = createReplayManifest(validManifestInput);

      const r1 = createReplayRecord(manifest.manifestId, 1, "worker-1");
      failReplay(r1.replayId, "error");

      expect(getReplayManifest(manifest.manifestId)?.reproducibilityState).toBe("FAILED");
    });
  });

  describe("listReplaysByManifest", () => {
    it("lists replays sorted by number", () => {
      const manifest = createReplayManifest(validManifestInput);

      createReplayRecord(manifest.manifestId, 3, "worker-3");
      createReplayRecord(manifest.manifestId, 1, "worker-1");
      createReplayRecord(manifest.manifestId, 2, "worker-2");

      const replays = listReplaysByManifest(manifest.manifestId);
      expect(replays[0].replayNumber).toBe(1);
      expect(replays[1].replayNumber).toBe(2);
      expect(replays[2].replayNumber).toBe(3);
    });
  });
});
