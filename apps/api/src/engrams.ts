/**
 * @file engrams.ts — Engram achievement + rewards routes (REW-001..003).
 */

import { Hono, type Context } from "hono";
import {
  AchievementEngine,
  newAchievementRule,
  buildMerkleTree,
  type VerifiedEvent,
} from "@crucible/engrams";
import { verifiedSessionFromContext, configuredChainId } from "./auth.js";

const engine = new AchievementEngine();

// Register a starter set of achievement rules (REW-001 catalogue).
engine.registerRule(
  newAchievementRule({
    id: "first-forge",
    version: 1,
    name: "The First Forge",
    description: "First qualifying verified trial.",
    qualifyingEvents: ["trial.settled"],
    requiredEvidence: ["runHash", "trialId"],
    tokenId: 1001,
    rarity: "common",
    issuanceCap: 0,
  }),
);
engine.registerRule(
  newAchievementRule({
    id: "break-survivor",
    version: 1,
    name: "The Break Survivor",
    description: "Run survived a valid adversarial challenge.",
    qualifyingEvents: ["trial.broken-survived"],
    requiredEvidence: ["runHash", "trialId", "argusVerdict"],
    tokenId: 1002,
    rarity: "rare",
  }),
);

export function createEngramRoutes(): Hono {
  const app = new Hono();

  /**
   * List entitlements for a recipient.
   *
   * Session-gated: only the recipient can query their own entitlements.
   * A public endpoint would leak achievement status for every address.
   */
  app.get("/:recipient", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const recipient = c.req.param("recipient");
    // Only allow querying your own entitlements
    if (session.payload.address.toLowerCase() !== recipient.toLowerCase()) {
      return c.json({ error: "forbidden", code: "not-your-entitlements" }, 403);
    }
    return c.json({ entitlements: engine.entitlementsFor(recipient) });
  });

  app.post("/evaluate", async (c) => {
    // Trusted worker only: requires keeper/warden bearer, never a user session.
    // A caller-supplied VerifiedEvent with verified:true is not authority (REW-001).
    const keeperKey = process.env.KEEPER_API_KEY ?? "";
    const auth = c.req.header("authorization") ?? "";
    if (!keeperKey || auth !== `Bearer ${keeperKey}`) {
      return c.json({ error: "forbidden: trusted worker required", code: "not-a-worker" }, 403);
    }
    let body: { event?: VerifiedEvent; recipient?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    if (!body.event) {
      return c.json({ error: "event is required", code: "bad-request" }, 400);
    }
    // Recipient is frozen from the verified event's agent/operator record,
    // never an arbitrary caller-supplied address. The worker supplies it.
    const recipient = body.recipient ?? body.event.recipient ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      return c.json({ error: "recipient address required", code: "bad-request" }, 400);
    }
    const result = engine.evaluate(body.event, recipient);
    return c.json(result, 201);
  });

  /**
   * Build a Merkle tree from distribution leaves.
   *
   * Session-gated: only authenticated callers can request Merkle proofs.
   * An unauthenticated endpoint would allow anyone to generate proofs for
   * arbitrary distributions, enabling Sybil attacks.
   */
  app.post("/merkle", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    let body: { leaves?: { recipient: string; amount: string; campaignId: string; tokenId: string }[] } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    const leaves: { recipient: `0x${string}`; amount: bigint; campaignId: bigint; tokenId: bigint }[] = [];
    for (const l of body.leaves ?? []) {
      let amount: bigint;
      let campaignId: bigint;
      let tokenId: bigint;
      try {
        amount = BigInt(l.amount);
        campaignId = BigInt(l.campaignId);
        tokenId = BigInt(l.tokenId);
      } catch {
        return c.json({ error: "amount, campaignId and tokenId must be whole numbers", code: "bad-request" }, 400);
      }
      leaves.push({ recipient: l.recipient as `0x${string}`, amount, campaignId, tokenId });
    }
    const tree = buildMerkleTree(leaves, BigInt(configuredChainId()));
    const proofs: Record<string, string[]> = {};
    for (const [leaf, proof] of tree.proofs.entries()) {
      proofs[leaf] = proof;
    }
    return c.json({ root: tree.root, leaves: tree.leaves, proofs });
  });

  return app;
}
