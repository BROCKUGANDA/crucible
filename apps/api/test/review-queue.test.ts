/**
 * @file review-queue.test.ts — the cases waiting for a reviewer.
 *
 * Three facts, kept apart: the case is chain-derived, the reviewer's own
 * state is durable, and a declared conflict BARS a reviewer from a case.
 *
 * The bar is the point of this file. A conflict that is merely displayed
 * is a conflict a reviewer in a hurry can ignore, and the review would
 * then carry a conflict nobody was told about at the moment it mattered.
 */

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { ReadModel, TrialRow } from "@crucible/indexer";
import { createReviewRoutes } from "../src/review-routes.js";
import {
  configureReviewStore,
  currentReviewStore,
  memoryReviewStore,
} from "../src/review-store.js";
import {
  configureCOIStore,
  newCOIEntry,
  recordCOI,
  __resetCOIStoreForTests,
  memoryCOIStore,
} from "@crucible/agent-security";
import { memoryAuditStore, configureAuditStore, __resetAuditStoreForTests } from "@crucible/agent-security";

const CALLER = "0x" + "44".repeat(20);
const OTHER = "0x" + "55".repeat(20);

function trial(overrides: Partial<TrialRow> = {}): TrialRow {
  return {
    id: 1,
    sponsor: "0x" + "66".repeat(20),
    specCID: "cidv0:sponsor",
    testsCID: "cidv0:tests",
    specDigest: "0x" + "aa".repeat(32),
    testsDigest: "0x" + "bb".repeat(32),
    rewardWei: 1_000_000_000_000_000n,
    bondWei: 0n,
    payoutWei: null,
    createdAt: 1,
    deadline: 2,
    breakWindow: 0,
    agentId: 7,
    runHash: null,
    runAt: null,
    breakSkeptic: null,
    breakStakeWei: null,
    breakProofCID: null,
    status: "judging",
    verdict: "none",
    disputeOpenedAt: null,
    ...overrides,
  } as TrialRow;
}

function modelWith(rows: TrialRow[]): ReadModel {
  const trials = new Map<number, TrialRow>();
  for (const row of rows) trials.set(row.id, row);
  return { trials } as unknown as ReadModel;
}

function appWith(rows: TrialRow[]) {
  const app = new Hono();
  app.route(
    "/v1/reviews",
    createReviewRoutes({ getModel: () => modelWith(rows) }),
  );
  return app;
}

/** A session the API accepts: the same shape the auth helper reads. */
function sessionCookie(address = CALLER): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { address, issuedAt: now, expiresAt: now + 3600, aud: "http://localhost:3000" };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");
  return `__Host-crucible_session=${encoded}.${signature}`;
}

const SECRET = "crucible-local-dev-secret-not-for-production";

function post(app: Hono, path: string, body: unknown, address = CALLER) {
  return app.request(`/v1/reviews${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie(address),
      origin: "http://127.0.0.1:3210",
    },
    body: JSON.stringify(body),
  });
}

function get(app: Hono, address = CALLER) {
  return app.request("/v1/reviews", {
    headers: { cookie: sessionCookie(address) },
  });
}

describe("the review queue", () => {
  beforeEach(async () => {
    configureReviewStore(memoryReviewStore());
    configureCOIStore(memoryCOIStore());
    configureAuditStore(memoryAuditStore());
    await currentReviewStore().reset();
    await __resetCOIStoreForTests();
    await __resetAuditStoreForTests();
  });

  it("lists the trials that are open for review, and not the settled ones", async () => {
    const app = appWith([
      trial({ id: 1, status: "judging" }),
      trial({ id: 2, status: "settled" }),
      trial({ id: 3, status: "challenged", disputeOpenedAt: 5 }),
    ]);
    const res = await get(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cases.map((c: { trialId: number }) => c.trialId)).toEqual([1, 3]);
  });

  it("does NOT offer a settled trial that was once disputed", async () => {
    // `disputeOpenedAt` says a dispute was opened at some point, and it
    // stays set after the trial settles. Reading it as "the dispute is
    // still open" puts every settled-and-disputed trial back on the
    // queue — a question the chain has already answered.
    const app = appWith([trial({ id: 4, status: "settled", disputeOpenedAt: 5 })]);
    const body = await (await get(app)).json();
    expect(body.cases).toEqual([]);
    const claim = await post(app, "/4/claim", {});
    expect(claim.status).toBe(403);
    expect((await claim.json()).code).toBe("case-closed");
  });

  it("says the reward in wei, as a string — never as a number", async () => {
    const app = appWith([trial({ id: 1, rewardWei: 12345678901234567890n })]);
    const body = await (await get(app)).json();
    expect(body.cases[0].rewardWei).toBe("12345678901234567890");
  });

  it("refuses an unauthenticated reader", async () => {
    const app = appWith([trial()]);
    const res = await app.request("/v1/reviews");
    expect(res.status).toBe(401);
  });

  it("lets a reviewer take a case, and tells them it is theirs", async () => {
    const app = appWith([trial({ id: 1 })]);
    const res = await post(app, "/1/claim", {});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.state).toBe("yours");

    const queue = await (await get(app)).json();
    expect(queue.cases[0].state.kind).toBe("yours");
  });

  it("refuses a case another reviewer already holds, and says who holds it", async () => {
    const app = appWith([trial({ id: 1 })]);
    await post(app, "/1/claim", {}, CALLER);
    const res = await post(app, "/1/claim", {}, OTHER);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("already-held");
    expect(body.error).toContain("another reviewer");
  });

  it("refuses a reviewer who already holds the case, and says so", async () => {
    const app = appWith([trial({ id: 1 })]);
    await post(app, "/1/claim", {});
    const again = await post(app, "/1/claim", {});
    expect(again.status).toBe(403);
    const body = await again.json();
    expect(body.code).toBe("already-yours");
    expect(body.error).toContain("you already hold this case");
  });

  it("BARS a reviewer who has declared a conflict — the case is not even offered", async () => {
    const sponsor = "0x" + "66".repeat(20);
    const app = appWith([trial({ id: 1, sponsor })]);
    // The reviewer declares an interest IN the sponsor: the sponsor is the
    // organisation the interest relates to, and naming it is what lets the
    // queue bar this reviewer from this trial.
    await recordCOI(
      newCOIEntry("coi-1", CALLER, "employer", "works at the sponsor", CALLER, sponsor),
    );

    // The queue does not offer it.
    const queue = await (await get(app)).json();
    expect(queue.cases.map((c: { trialId: number }) => c.trialId)).toEqual([]);

    // And a direct claim is refused.
    const res = await post(app, "/1/claim", {});
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("conflicted");
  });

  it("records a conflict declaration in the register and in the audit chain", async () => {
    const app = appWith([trial({ id: 1 })]);
    const res = await post(app, "/1/conflict", {
      type: "employer",
      description: "works at the sponsor",
    });
    expect(res.status).toBe(201);

    const { listCOIForPrincipal } = await import("@crucible/agent-security");
    const entries = await listCOIForPrincipal(CALLER);
    expect(entries.length).toBe(1);
    expect(entries[0].description).toBe("works at the sponsor");

    const { listAllAudit } = await import("@crucible/agent-security");
    const audit = await listAllAudit();
    expect(audit.map((entry) => entry.action)).toContain("review:conflict");
  });

  it("releases the claim when a conflict is declared", async () => {
    const app = appWith([trial({ id: 1 })]);
    await post(app, "/1/claim", {});
    await post(app, "/1/conflict", { description: "works at the sponsor" });
    const queue = await (await get(app)).json();
    // The case is barred, so it is not in the reviewer's queue at all...
    expect(queue.cases.length).toBe(0);
    // ...and their claim is not holding it either: the claim was released,
    // so another reviewer may take the case. A stale claim held by a
    // conflicted reviewer would block the case for everybody.
    const other = await post(app, "/1/claim", {}, OTHER);
    expect(other.status).toBe(201);
    const otherQueue = await (await get(app, OTHER)).json();
    expect(otherQueue.cases[0].state.kind).toBe("yours");
  });

  it("records an abstention with the reviewer's own words, and releases the claim", async () => {
    const app = appWith([trial({ id: 1 })]);
    await post(app, "/1/claim", {});
    const res = await post(app, "/1/abstain", { reason: "I built the suite" });
    expect(res.status).toBe(201);

    const queue = await (await get(app)).json();
    expect(queue.abstentions.length).toBe(1);
    expect(queue.abstentions[0].reason).toBe("I built the suite");
    // And the reviewer does not hold it any more.
    const other = await (await get(app, OTHER)).json();
    expect(other.cases[0].state.kind).toBe("open");
  });

  it("refuses an abstention with no reason", async () => {
    const app = appWith([trial({ id: 1 })]);
    const res = await post(app, "/1/abstain", { reason: "   " });
    expect(res.status).toBe(400);
  });

  it("refuses an abstained reviewer the case", async () => {
    const app = appWith([trial({ id: 1 })]);
    await post(app, "/1/abstain", { reason: "I built the suite" });
    const res = await post(app, "/1/claim", {});
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("abstained");
  });

  it("refuses a case that does not exist, and one that is settled", async () => {
    const app = appWith([trial({ id: 1, status: "settled" })]);
    const missing = await post(app, "/99/claim", {});
    expect(missing.status).toBe(403);
    expect((await missing.json()).code).toBe("no-such-case");

    const settled = await post(app, "/1/claim", {});
    expect(settled.status).toBe(403);
    expect((await settled.json()).code).toBe("case-closed");
  });
});
