/**
 * @file evidence-bundle-pg.test.ts — the frozen bundle, in PostgreSQL.
 *
 * The claim under test: a frozen bundle survives a restart, and it cannot
 * be edited afterwards — the property a committee relies on when it reads
 * the evidence a dispute was broken over.
 *
 * The store is exercised against a REAL PostgreSQL. A fake pool cannot tell
 * you that a later write overwrote the bundle, which is exactly the
 * failure this file exists to catch.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "@crucible/agent-security";
import {
  configureEvidenceBundleStore,
  resetEvidenceBundleStore,
  evidenceBundleStoreKind,
  type EvidenceBundleStore,
} from "../src/evidence-bundle-store.js";
import { pgEvidenceBundleStore } from "../src/evidence-bundle-pg.js";
import { assembleBundle, verifyBundleDigest, type EvidenceBundle } from "../src/evidence-bundle.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return assembleBundle({
    trialKey: "42",
    sealedAt: 1_700_000_000_000,
    chain: { trialId: 42, specDigest: "0x" + "a".repeat(64), breakSkeptic: "0xskeptic" },
    spec: null,
    manifests: [],
    aggregate: null,
    dimensionScores: [],
    ...overrides,
  });
}

suite("evidence-bundle-pg", () => {
  let store: EvidenceBundleStore;

  beforeAll(async () => {
    await runMigrations();
    configureEvidenceBundleStore(pgEvidenceBundleStore(), "postgresql");
    store = pgEvidenceBundleStore();
  });

  afterAll(async () => {
    resetEvidenceBundleStore();
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM dispute_evidence_bundles");
  });

  it("says that the record is durable", () => {
    expect(evidenceBundleStoreKind()).toBe("postgresql");
  });

  it("keeps a frozen bundle across a fresh read — the way another process reads it", async () => {
    const sealed = bundle();
    await store.record(sealed, true);

    const found = await store.get(sealed.id);
    expect(found).not.toBeNull();
    expect(found?.bundle.trialKey).toBe("42");
    expect(found?.bundle.chain?.breakSkeptic).toBe("0xskeptic");
    expect(found?.predatesDispute).toBe(true);
    // And it still verifies: the stored bytes are the bytes the address names.
    expect(verifyBundleDigest(found!.bundle)).toBe(true);
  });

  it("does not let a later bundle overwrite a frozen one, even with the same id", async () => {
    const sealed = bundle();
    await store.record(sealed, true);

    // A second write with the SAME id but different contents — which is what
    // editing the evidence would look like. The address forbids it.
    const tampered: EvidenceBundle = { ...sealed, measurement: { ...sealed.measurement, aggregateBps: 10000 } };
    await store.record(tampered, false);

    const found = await store.get(sealed.id);
    expect(found?.bundle.measurement.aggregateBps).toBeNull();
    expect(verifyBundleDigest(found!.bundle)).toBe(true);
  });

  it("lists the bundles of a trial, oldest first", async () => {
    const first = bundle({ sealedAt: 1_700_000_000_000 });
    // Different evidence, so a different address: this is a second freeze.
    const second = bundle({
      sealedAt: 1_700_000_100_000,
      chain: { trialId: 42, specDigest: "0x" + "b".repeat(64) },
    });
    await store.record(second, true);
    await store.record(first, true);

    const listed = await store.listForTrial("42");
    expect(listed.length).toBe(2);
    expect(listed[0]?.sealedAt).toBe(1_700_000_000_000);
    expect(listed[1]?.sealedAt).toBe(1_700_000_100_000);
  });

  it("returns nothing for a bundle that does not exist", async () => {
    expect(await store.get("bundle_nothing_here")).toBeNull();
  });
});
