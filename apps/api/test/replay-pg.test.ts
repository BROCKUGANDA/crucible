/**
 * @file replay-pg.test.ts — the measurement, in PostgreSQL.
 *
 * The claim under test: a measurement survives a restart, and the durable
 * store says the same things the in-memory store says — including the
 * WORKER each replay came from, because the independence rule is decided
 * on that.
 *
 * The store is exercised against a REAL PostgreSQL. A fake cannot tell you
 * that a column does not exist, that a NOT NULL constraint refuses a write
 * the in-memory path accepts happily, or that the uniqueness rule on
 * (manifest, replay number) is enforced by anything at all.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "@crucible/agent-security";
import { configureReplayStore, replayStoreKind, type ReplayStore } from "../src/replay-store.js";
import { pgReplayStore } from "../src/replay-pg.js";
import {
  createReplayManifest,
  createReplayRecord,
  completeReplay,
  getReplayManifest,
  listReplaysByManifest,
  isVerified,
  resetReplayStore,
  type ReplayManifest,
} from "../src/replay-manifest.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

const INPUT = {
  trialId: "trial_replay_pg_1",
  runId: "run_replay_pg_1",
  specDigest: "sha256:spec-digest-pg-1",
  suiteVersion: "1.0.0",
  agentId: "agent_replay_pg_1",
  runtimeImageDigest: "sha256:image-pg-1",
  executionConfig: { timeoutMs: 1000 },
  judgeVersion: "judge-1",
  environmentFingerprint: "env-pg-1",
  artifactHashes: { "artifact-1": "sha256:artifact-digest-pg-1" },
  workerIdentity: "worker-1",
};

suite("replay-pg", () => {
  let store: ReplayStore;

  beforeAll(async () => {
    await runMigrations();
    configureReplayStore(pgReplayStore());
    store = pgReplayStore();
  });

  afterAll(async () => {
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM replay_measurement_records");
    await getPool().query("DELETE FROM replay_measurements");
    await resetReplayStore();
  });

  it("says that the measurement is durable", () => {
    expect(replayStoreKind()).toBe("postgresql");
  });

  it("keeps a manifest across a fresh read — the way another process reads it", async () => {
    const manifest = await createReplayManifest(INPUT);
    const found = await store.getManifest(manifest.manifestId);
    expect(found).toBeDefined();
    expect(found?.trialId).toBe(INPUT.trialId);
    expect(found?.specDigest).toBe(INPUT.specDigest);
    expect(found?.executionConfig).toEqual({ timeoutMs: 1000 });
  });

  it("keeps the WORKER each replay came from, because the rule is decided on it", async () => {
    const manifest = await createReplayManifest(INPUT);
    const one = await createReplayRecord(manifest.manifestId, 1, "worker-a");
    const two = await createReplayRecord(manifest.manifestId, 2, "worker-b");
    const three = await createReplayRecord(manifest.manifestId, 3, "worker-c");
    await completeReplay(one.replayId, "sha256:same");
    await completeReplay(two.replayId, "sha256:same");
    await completeReplay(three.replayId, "sha256:same");

    const found = await store.listReplaysByManifest(manifest.manifestId);
    expect(found.map((r) => r.workerIdentity)).toEqual(["worker-a", "worker-b", "worker-c"]);
    expect((await store.getManifest(manifest.manifestId))?.reproducibilityState).toBe("REPRODUCIBLE");
  });

  it("records the caller's NAME for a replay without mistaking it for a worker", async () => {
    const manifest = await createReplayManifest(INPUT);
    const one = await createReplayRecord(manifest.manifestId, 1, "worker-a", "label-one");
    const two = await createReplayRecord(manifest.manifestId, 2, "worker-a", "label-two");
    const three = await createReplayRecord(manifest.manifestId, 3, "worker-a", "label-three");
    await completeReplay(one.replayId, "sha256:same");
    await completeReplay(two.replayId, "sha256:same");
    await completeReplay(three.replayId, "sha256:same");

    const found = await store.listReplaysByManifest(manifest.manifestId);
    expect(found.map((r) => r.label)).toEqual(["label-one", "label-two", "label-three"]);
    expect(new Set(found.map((r) => r.workerIdentity)).size).toBe(1);
    // One worker, three agreeing replays: the rule is not met, and the
    // manifest says which of the two reasons it is not.
    const manifest2 = await getReplayManifest(manifest.manifestId);
    expect(manifest2?.reproducibilityState).toBe("INCONCLUSIVE");
    expect(manifest2?.reproducibilityNote).toContain("1 worker");
    expect(await isVerified(manifest.manifestId)).toBe(false);
  });

  it("refuses two replays with the same number in the same manifest", async () => {
    const manifest = await createReplayManifest(INPUT);
    await createReplayRecord(manifest.manifestId, 1, "worker-a");
    await expect(createReplayRecord(manifest.manifestId, 1, "worker-b")).rejects.toThrow(
      "already exists",
    );
  });

  it("moves a replay's status as it completes, and keeps its identity", async () => {
    const manifest = await createReplayManifest(INPUT);
    const replay = await createReplayRecord(manifest.manifestId, 1, "worker-a", "label-one");
    expect((await store.getReplay(replay.replayId))?.status).toBe("PENDING");

    await completeReplay(replay.replayId, "sha256:same");

    const found = await store.getReplay(replay.replayId);
    expect(found?.status).toBe("COMPLETED");
    expect(found?.workerIdentity).toBe("worker-a");
    expect(found?.label).toBe("label-one");
  });

  it("lists the manifests of a trial and of a run", async () => {
    const one: ReplayManifest = await createReplayManifest(INPUT);
    await createReplayManifest({ ...INPUT, runId: "run_replay_pg_2" });

    expect((await store.listManifestsByTrial(INPUT.trialId)).length).toBe(2);
    expect((await store.listManifestsByRun(INPUT.runId)).length).toBe(1);
    expect((await store.listManifestsByRun(INPUT.runId))[0].manifestId).toBe(one.manifestId);
  });

  it("lists the replays of a manifest in order", async () => {
    const manifest = await createReplayManifest(INPUT);
    await createReplayRecord(manifest.manifestId, 3, "worker-c");
    await createReplayRecord(manifest.manifestId, 1, "worker-a");
    await createReplayRecord(manifest.manifestId, 2, "worker-b");

    const replays = await listReplaysByManifest(manifest.manifestId);
    expect(replays.map((r) => r.replayNumber)).toEqual([1, 2, 3]);
  });
});
