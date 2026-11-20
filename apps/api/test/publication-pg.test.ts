/**
 * @file publication-pg.test.ts — the published method, in PostgreSQL.
 *
 * The claim under test: a published method survives a restart, and the
 * durable store says the same things the in-memory store says.
 *
 * The store is exercised against a REAL PostgreSQL. A fake cannot tell you
 * that a column does not exist, that a NOT NULL constraint refuses a write
 * that the in-memory path accepts happily, or that two rows collide — and
 * the difference between the two stores is exactly where a published
 * record would go missing.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "@crucible/agent-security";
import {
  configurePublicationStore,
  resetPublicationStore,
  publicationStoreKind,
  type PublicationStore,
} from "../src/publication-store.js";
import { pgPublicationStore } from "../src/publication-pg.js";
import type { PublishedMethod } from "../src/publication.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

function card(overrides: Partial<PublishedMethod> = {}): PublishedMethod {
  return {
    id: "pub_test_card_1",
    subject: { kind: "trial", id: "trial_pg_1", agentId: "agent_pg_1" },
    specDigest: "sha256:spec-digest-pg-1",
    suite: {
      suiteId: "suite_pg_1",
      name: "PG Suite",
      versionId: "sv_pg_1",
      version: "1.0.0",
      specDigest: "sha256:suite-digest-pg-1",
      difficulty: "medium",
      evaluationProtocol: "deterministic",
      knownLimitations: "does not test concurrency",
    },
    rubric: {
      rubricId: "rubric_pg_1",
      name: "PG Rubric",
      status: "ACTIVE",
      dimensions: [],
      aggregateBps: 9000,
      confidenceLowerBps: 8000,
      confidenceUpperBps: 10000,
      sampleCount: 3,
      scoreStatus: "VERIFIED",
    },
    judge: {
      judgeVersion: "judge-1",
      runtimeImageDigest: "sha256:image-pg-1",
      environmentFingerprint: "env-pg-1",
      configDigest: null,
      modelId: "model-pg-1",
    },
    repetitions: {
      required: 3,
      performed: 3,
      agreed: true,
      agreementRule: "three replays must agree",
      replays: [],
    },
    limits: ["This score establishes only what was measured against the suite version above."],
    comparabilityKey: "sha256:suite-digest-pg-1/rubric_pg_1/judge-1",
    digest: "digest-pg-1",
    publishedAt: 1_700_000_000_000,
    ...overrides,
  };
}

suite("publication-pg", () => {
  let store: PublicationStore;

  beforeAll(async () => {
    await runMigrations();
    configurePublicationStore(pgPublicationStore(), "postgresql");
    store = pgPublicationStore();
  });

  afterAll(async () => {
    resetPublicationStore();
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM publication_comparisons");
    await getPool().query("DELETE FROM published_methods");
  });

  it("says that the record is durable", () => {
    expect(publicationStoreKind()).toBe("postgresql");
  });

  it("keeps a published method across a fresh read — the way another process reads it", async () => {
    const published = card();
    await store.record(published);

    // Read it back from the DATABASE, not from the object that was built.
    const found = await store.get(published.id);
    expect(found).not.toBeNull();
    expect(found?.suite?.specDigest).toBe("sha256:suite-digest-pg-1");
    expect(found?.rubric.aggregateBps).toBe(9000);
    expect(found?.limits.length).toBe(1);
    expect(found?.repetitions.agreed).toBe(true);
  });

  it("keeps the card EXACTLY as published — the limits and all", async () => {
    const published = card({
      limits: [
        "This score establishes only what was measured against the suite version above.",
        "The suite's own published limitations apply: does not test concurrency",
      ],
    });
    await store.record(published);
    const found = await store.get(published.id);
    expect(found?.limits).toEqual(published.limits);
    expect(found?.digest).toBe(published.digest);
  });

  it("is append-only: publishing the same card twice does not duplicate it", async () => {
    await store.record(card());
    await store.record(card());
    const all = await store.list({ subjectId: "trial_pg_1" });
    expect(all.length).toBe(1);
  });

  it("lists the cards of a subject, and finds the ones that may be compared", async () => {
    await store.record(card());
    await store.record(
      card({
        id: "pub_test_card_2",
        subject: { kind: "trial", id: "trial_pg_2", agentId: "agent_pg_2" },
        digest: "digest-pg-2",
      }),
    );

    const one = await store.list({ subjectId: "trial_pg_1" });
    expect(one.length).toBe(1);
    expect(one[0]?.subject.id).toBe("trial_pg_1");

    const comparable = await store.list({
      comparabilityKey: "sha256:suite-digest-pg-1/rubric_pg_1/judge-1",
    });
    expect(comparable.length).toBe(2);
  });

  it("records a comparison and reads it back", async () => {
    await store.record(card());
    await store.record(
      card({ id: "pub_test_card_2", subject: { kind: "trial", id: "trial_pg_2", agentId: "a" }, digest: "d2" }),
    );
    const written = await store.recordComparison({
      leftId: "pub_test_card_1",
      rightId: "pub_test_card_2",
      comparable: false,
      reason: "different suite digests",
      differences: ["different suite digests"],
      comparedAt: 1_700_000_000_001,
    });
    expect(written.comparable).toBe(false);

    const comparisons = await store.listComparisons("pub_test_card_1");
    expect(comparisons.length).toBe(1);
    expect(comparisons[0]?.reason).toBe("different suite digests");
  });

  it("does not let a later card overwrite a published one, even with the same id", async () => {
    const published = card({ limits: ["the first card"] });
    await store.record(published);

    // A second write with the SAME id but different contents — which is what
    // a bug that edits a published method would look like. The address
    // forbids it: the stored card keeps its contents.
    await store.record(card({ limits: ["a rewritten card"] }));
    const found = await store.get(published.id);
    expect(found?.limits).toEqual(["the first card"]);
  });

  it("returns nothing for a publication that does not exist", async () => {
    expect(await store.get("pub_nothing_here")).toBeNull();
  });
});
