/**
 * @file evidence-bundle-routes.ts — the frozen evidence of a dispute.
 *
 * Three things, and none of them lets the caller state a fact:
 *
 *   - **seal** the bundle for a trial: the platform reads the chain's facts
 *     and the platform's measurement, and freezes them;
 *   - **read** the bundles of a trial, oldest first;
 *   - **read** one bundle by its address.
 *
 * A caller may not bring its own evidence, its own gaps or its own digest.
 * A bundle is a statement about what the platform saw, and a bundle a
 * caller can write is a bundle nobody can rely on.
 *
 * The route also answers the question that decides whether a bundle is
 * usable at all: **was it sealed before the trial was broken?** A bundle
 * sealed afterwards may contain evidence the parties never saw, and
 * serving it as if it were the dispute's evidence would be wrong. The
 * answer is a property of two timestamps, so anyone can check it.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
import { buildBundle, predatesDispute, type BundleChainFacts } from "./evidence-bundle.js";
import {
  evidenceBundleStoreKind,
  getEvidenceBundleStore,
} from "./evidence-bundle-store.js";
import type { ReadModel } from "@crucible/indexer";

/**
 * The fields a caller may not supply.
 *
 * Refused by NAME, whatever the value: a caller who sends `gaps` is trying
 * to state what is missing, and a route that ignored it would teach people
 * that the field works.
 */
const FORBIDDEN_FIELDS = [
  "gaps",
  "digest",
  "chain",
  "measurement",
  "sealedAt",
  "bundle",
  "score",
  "verdict",
];

export interface EvidenceBundleRouteDeps {
  /** The chain's read model, for the chain facts. */
  getModel?: () => ReadModel;
  /**
   * The chain's clock, in seconds, when this host can read it.
   *
   * The seal is compared against the dispute on the chain's clock, and the
   * chain's clock is not the host's clock. When it cannot be read, the
   * bundle says the order cannot be established rather than guessing.
   */
  chainNow?: () => number | null;
}

/**
 * The chain's facts for a trial, as the read model has them.
 *
 * Every field is nullable and null means "the chain has not said". The
 * bundle is where those absences are recorded, so nothing is invented here
 * to fill a hole.
 */
export function chainFactsFor(model: ReadModel | undefined, trialId: number): Partial<BundleChainFacts> | null {
  if (!model) return null;
  const row = model.trials.get(trialId);
  if (!row) return null;
  return {
    trialId: row.id,
    sponsor: row.sponsor,
    status: row.status,
    verdict: row.verdict,
    specDigest: row.specDigest,
    testsDigest: row.testsDigest,
    // The CIDs come from the sponsor's disclosure, which the indexer keeps
    // beside the row when the host supplies it.
    disclosedSpecCid: row.specCID,
    disclosedTestsCid: row.testsCID,
    breakSkeptic: row.breakSkeptic,
    breakProofCid: row.breakProofCID,
    disputeOpenedAt: row.disputeOpenedAt,
  };
}

export function createEvidenceBundleRoutes(deps: EvidenceBundleRouteDeps = {}): Hono {
  const app = new Hono();

  /**
   * Seal the bundle for a trial.
   *
   * The freeze is what the platform saw AT THIS MOMENT, so a second seal
   * after new evidence arrives produces a different bundle with a different
   * address — both are kept, and the one that predates the dispute is
   * marked.
   */
  app.post("/:trialId/bundle", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    for (const field of FORBIDDEN_FIELDS) {
      if (field in body) {
        return c.json(
          {
            error: `the caller may not supply "${field}": a bundle states what the platform saw`,
            code: "caller-supplied-evidence-refused",
          },
          400,
        );
      }
    }

    const trialId = c.req.param("trialId");
    if (!/^[0-9]+$/.test(trialId)) {
      return c.json({ error: "the trial id must be a number", code: "bad-request" }, 400);
    }

    const model = deps.getModel?.();
    const facts = chainFactsFor(model, Number(trialId));
    const sealedAt = Date.now();

    // The bundle is assembled ONCE, with the chain's facts inside it, so
    // the gaps it states are the gaps of the bundle as sealed. A bundle
    // whose gaps were patched afterwards would be a bundle whose address
    // did not cover its own contents.
    const bundle = buildBundle(trialId, sealedAt, facts, deps.chainNow?.() ?? null);
    const predates = predatesDispute(bundle, facts?.disputeOpenedAt ?? null);
    const stored = await getEvidenceBundleStore().record(bundle, predates);

    return c.json(
      {
        bundle: stored.bundle,
        predatesDispute: stored.predatesDispute,
        store: evidenceBundleStoreKind(),
        sealedBy: session.payload.address.toLowerCase(),
      },
      201,
    );
  });

  /** The bundles of a trial, oldest first. */
  app.get("/:trialId/bundles", async (c) => {
    const trialId = c.req.param("trialId");
    const stored = await getEvidenceBundleStore().listForTrial(trialId);
    return c.json({
      trialId,
      bundles: stored.map((s) => ({
        id: s.bundle.id,
        sealedAt: s.sealedAt,
        predatesDispute: s.predatesDispute,
        digest: s.bundle.digest,
        gaps: s.bundle.gaps.length,
      })),
      store: evidenceBundleStoreKind(),
    });
  });

  /** One bundle, by its address. */
  app.get("/bundles/:id", async (c) => {
    const id = c.req.param("id");
    const stored = await getEvidenceBundleStore().get(id);
    if (!stored) return c.json({ error: "no such bundle", code: "no-such-bundle" }, 404);
    return c.json({ bundle: stored.bundle, predatesDispute: stored.predatesDispute });
  });

  return app;
}
