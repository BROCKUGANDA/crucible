/**
 * @file publication-routes.ts — the method card of a published score.
 *
 * Four things, and none of them lets the caller state a fact:
 *
 *   - publish the method of a trial or a run (the server assembles it);
 *   - read a published card;
 *   - list the published cards of a subject;
 *   - compare two cards, with an explicit "not comparable" verdict.
 *
 * The route refuses a caller-supplied score, verdict, limit or digest. A
 * publication is a statement about what the platform measured; a caller who
 * can supply the statement is not publishing a measurement.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
import { comparePublications, publishForRun, publishForTrial, type PublishedMethod } from "./publication.js";
import { getPublicationStore, publicationStoreKind } from "./publication-store.js";

/**
 * The fields a caller may not supply.
 *
 * The route rejects a body that carries any of them by NAME, whatever the
 * value: a caller who sends `score` is trying to state the measurement,
 * and a route that silently ignored it would teach people that the field
 * works.
 */
const FORBIDDEN_FIELDS = [
  "score",
  "verdict",
  "status",
  "limits",
  "digest",
  "comparabilityKey",
  "aggregateBps",
  "scoreBps",
  "publishedAt",
];

export function createPublicationRoutes(): Hono {
  const app = new Hono();

  /**
   * Publish the method of a trial or a run.
   *
   * The response says what was published. If there is nothing to publish —
   * a trial with no replay manifest — the route says that, with a reason,
   * rather than returning an empty card.
   */
  app.post("/", async (c) => {
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);

    for (const field of FORBIDDEN_FIELDS) {
      if (field in body) {
        return c.json(
          {
            error: `the caller may not supply "${field}": a publication states what the platform measured`,
            code: "caller-supplied-verdict-refused",
          },
          400,
        );
      }
    }

    const trialId = typeof body.trialId === "string" ? body.trialId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!trialId && !runId) {
      return c.json({ error: "trialId or runId is required", code: "bad-request" }, 400);
    }

    const publishedAt = Date.now();
    const method = trialId
      ? publishForTrial(trialId, publishedAt)
      : publishForRun(runId, publishedAt);
    if (!method) {
      return c.json(
        {
          error: "there is no replay manifest for that subject, so there is no method to publish",
          code: "no-manifest",
        },
        404,
      );
    }

    const stored = await getPublicationStore().record(method);
    return c.json({ publication: stored, store: publicationStoreKind() }, 201);
  });

  /**
   * Compare two published cards.
   *
   * The verdict is explicit: comparable, or not comparable with the reason.
   * There is no "close enough" — two numbers measured against different
   * suites are two different numbers, and the honest answer is that they
   * cannot be compared.
   */
  app.get("/compare", async (c) => {
    const a = c.req.query("a")?.trim();
    const b = c.req.query("b")?.trim();
    if (!a || !b) {
      return c.json({ error: "a and b are required", code: "bad-request" }, 400);
    }
    const left = await getPublicationStore().get(a);
    const right = await getPublicationStore().get(b);
    if (!left || !right) {
      return c.json({ error: "both publications must exist", code: "no-such-publication" }, 404);
    }
    const verdict = comparePublications(left, right);
    const recorded = await getPublicationStore().recordComparison({
      leftId: left.id,
      rightId: right.id,
      comparable: verdict.comparable,
      reason: verdict.reason,
      differences: verdict.differences,
      comparedAt: Date.now(),
    });
    return c.json({
      comparison: {
        ...verdict,
        left: summarise(left),
        right: summarise(right),
        recordedAt: recorded.comparedAt,
      },
    });
  });

  /** One published card. */
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const card = await getPublicationStore().get(id);
    if (!card) return c.json({ error: "no such publication", code: "no-such-publication" }, 404);
    const comparisons = await getPublicationStore().listComparisons(id);
    return c.json({ publication: card, comparisons });
  });

  /** The published cards of a subject. */
  app.get("/", async (c) => {
    const subjectId = c.req.query("subjectId")?.trim();
    const kind = c.req.query("kind")?.trim();
    const cards = await getPublicationStore().list({
      subjectId: subjectId || undefined,
      kind: kind === "run" || kind === "trial" ? kind : undefined,
    });
    return c.json({ publications: cards });
  });

  return app;
}

/** The head of a card, for a comparison view. */
function summarise(card: PublishedMethod) {
  return {
    id: card.id,
    subject: card.subject,
    measurementKey: card.measurementKey,
    suiteDigest: card.suite?.specDigest ?? null,
    suiteVersion: card.suite?.version ?? null,
    rubricId: card.rubric.rubricId,
    judgeVersion: card.judge.judgeVersion,
    aggregateBps: card.rubric.aggregateBps,
    limits: card.limits.length,
  };
}
