/**
 * @file review-routes.ts — the review queue.
 *
 * The queue of cases waiting for a reviewer, and the three things a
 * reviewer may do about one: take it, step away from it, or declare a
 * conflict of interest with it.
 *
 * The conflict declaration is the interesting one. It writes to the
 * DURABLE conflict register (ADR-0038) and to the DURABLE audit chain
 * (ADR-0037) — so a declaration is a record that outlives the process,
 * and it is what the queue's refusal checks afterwards. A reviewer who
 * declares a conflict is barred from that case from that moment on; the
 * bar is enforced by the platform, not by the reviewer's memory.
 */

import { Hono, type Context } from "hono";
import type { ReadModel } from "@crucible/indexer";
import { verifiedSessionFromContext } from "./auth.js";
import {
  createAuditEntry,
  newAuditEntry,
  newCOIEntry,
  recordCOI,
} from "@crucible/agent-security";
import { openCases, refusalFor, reviewerStateFor } from "./review-queue.js";
import { currentReviewStore, reviewStoreKind } from "./review-store.js";

/**
 * The id of an audit entry.
 *
 * The chain is APPEND-ONLY: an entry is an event, and two events are two
 * entries. A deterministic id (one per action per case) would make the
 * second claim of the same case collide with the first — and a collision
 * on an append-only chain is not a retry, it is a refusal.
 */
function auditId(action: string, trialId: number, reviewer: string): string {
  return `audit-${action}-${trialId}-${reviewer}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ReviewRouteDeps {
  /** The chain's read model — the cases are chain-derived. */
  getModel: () => ReadModel;
}

export function createReviewRoutes(deps: ReviewRouteDeps): Hono {
  const app = new Hono();

  /** The reviewer, from the verified session. Never from the body. */
  const reviewerOf = (c: Context): string | null => {
    const session = verifiedSessionFromContext(c);
    return session ? session.payload.address.toLowerCase() : null;
  };

  /**
   * The queue.
   *
   * A case the reviewer is conflicted with is not in the list at all: the
   * queue is what a reviewer MAY take, and a conflicted reviewer may not
   * take that case. The conflicts a reviewer HAS declared are listed
   * beside it, so the register is visible to the person who filled it in.
   */
  app.get("/", async (c) => {
    const reviewer = reviewerOf(c);
    if (!reviewer) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    const model = deps.getModel();
    const cases = [];
    for (const trial of openCases(model)) {
      const { state, conflicts } = await reviewerStateFor(model, trial.id, reviewer);
      if (conflicts.length > 0) continue; // barred: not offered
      cases.push({
        trialId: trial.id,
        sponsor: trial.sponsor.toLowerCase(),
        agent: trial.agentId === null ? null : String(trial.agentId),
        status: trial.status,
        specDigest: trial.specDigest,
        rewardWei: trial.rewardWei.toString(),
        deadline: trial.deadline,
        disclosed: trial.specCID !== null,
        state,
      });
    }

    const abstentions = await currentReviewStore().listAbstentions();
    return c.json({
      cases,
      store: reviewStoreKind(),
      abstentions: abstentions.filter((entry) => entry.reviewer === reviewer),
    });
  });

  /**
   * Take a case.
   *
   * The refusal checks come first, and they are the platform's job:
   * a conflicted reviewer, an abstained reviewer and a case held by
   * somebody else are all refused with the reason.
   */
  app.post("/:trialId/claim", async (c) => {
    const reviewer = reviewerOf(c);
    if (!reviewer) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    const trialId = Number(c.req.param("trialId"));
    if (!Number.isInteger(trialId) || trialId < 0) {
      return c.json({ error: "the trial id must be a number", code: "bad-request" }, 400);
    }

    const model = deps.getModel();
    const refusal = await refusalFor(model, trialId, reviewer);
    if (refusal) {
      return c.json({ error: refusal.reason, code: refusal.code }, 403);
    }

    await currentReviewStore().claim({ trialId, reviewer, claimedAt: Date.now() });
    await createAuditEntry(
      await newAuditEntry(
        auditId("review-claim", trialId, reviewer),
        reviewer,
        "review:claim",
        { trialId },
        undefined,
        String(trialId),
      ),
    );

    return c.json({ trialId, reviewer, state: "yours" as const }, 201);
  });

  /**
   * Step away from a case.
   *
   * The reason is recorded verbatim: this is the reviewer's own words
   * about their own conflict, and paraphrasing it would be the platform
   * editing the reason. The claim is released with it — a reviewer who
   * stepped away does not hold the case.
   */
  app.post("/:trialId/abstain", async (c) => {
    const reviewer = reviewerOf(c);
    if (!reviewer) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    const trialId = Number(c.req.param("trialId"));
    if (!Number.isInteger(trialId) || trialId < 0) {
      return c.json({ error: "the trial id must be a number", code: "bad-request" }, 400);
    }

    let body: { reason?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    const reason = (body.reason ?? "").trim();
    if (!reason) {
      return c.json({ error: "a reason is required", code: "bad-request" }, 400);
    }

    const model = deps.getModel();
    if (!model.trials.has(trialId)) {
      return c.json({ error: "there is no such case", code: "no-such-case" }, 404);
    }

    await currentReviewStore().abstain({ trialId, reviewer, reason, abstainedAt: Date.now() });
    await currentReviewStore().release(trialId, reviewer);
    await createAuditEntry(
      await newAuditEntry(
        auditId("review-abstain", trialId, reviewer),
        reviewer,
        "review:abstain",
        { trialId, reason },
        undefined,
        String(trialId),
      ),
    );

    return c.json({ trialId, reviewer, abstained: true }, 201);
  });

  /**
   * Declare a conflict of interest with a case.
   *
   * The declaration goes into the durable conflict register — so it
   * outlives this process — and into the durable audit chain. After it,
   * the queue refuses this reviewer that case: a conflict that is merely
   * displayed is a conflict a reviewer in a hurry can ignore.
   *
   * The reviewer declares the conflict with themselves; the platform does
   * not decide whether it is a real one. It records what was declared.
   */
  app.post("/:trialId/conflict", async (c) => {
    const reviewer = reviewerOf(c);
    if (!reviewer) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    const trialId = Number(c.req.param("trialId"));
    if (!Number.isInteger(trialId) || trialId < 0) {
      return c.json({ error: "the trial id must be a number", code: "bad-request" }, 400);
    }

    let body: { type?: string; description?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    const type = String(body.type ?? "employer") as Parameters<typeof newCOIEntry>[2];
    const description = (body.description ?? "").trim();
    if (!description) {
      return c.json({ error: "a description is required", code: "bad-request" }, 400);
    }

    const model = deps.getModel();
    const trial = model.trials.get(trialId);
    if (!trial) {
      return c.json({ error: "there is no such case", code: "no-such-case" }, 404);
    }

    const entry = newCOIEntry(
      `coi-review-${trialId}-${reviewer}`,
      reviewer,
      type,
      description,
      reviewer,
      // The interest is IN the sponsor: the trial's sponsor is the
      // organisation the interest relates to, and naming it is what lets
      // the queue bar this reviewer from this trial — and from every
      // other trial that sponsor runs.
      trial.sponsor.toLowerCase(),
    );
    await recordCOI(entry);
    await createAuditEntry(
      await newAuditEntry(
        auditId("review-conflict", trialId, reviewer),
        reviewer,
        "review:conflict",
        { trialId, type },
        undefined,
        String(trialId),
      ),
    );

    // The claim is released: a reviewer with a declared conflict does not
    // hold the case.
    await currentReviewStore().release(trialId, reviewer);

    return c.json({ trialId, reviewer, conflict: entry.id }, 201);
  });

  return app;
}
