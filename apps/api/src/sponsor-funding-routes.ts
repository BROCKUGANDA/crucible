/**
 * @file sponsor-funding-routes.ts — a sponsor's money, as the API serves it.
 *
 * The routes do three things, and none of them is "accept the sponsor's word
 * for it":
 *
 *   - record what a program claims it funded (a claim, which counts as
 *     nothing until the chain confirms it);
 *   - check that claim against the chain, and write down what the chain said;
 *   - report both numbers — what was claimed and what was confirmed — because
 *     the difference between them IS the finding.
 *
 * A claim that cannot be checked is reported as unverifiable, with the
 * reason. It is never quietly counted as paid.
 */

import { Hono, type Context } from "hono";
import { isMemberOf } from "@crucible/agent-security";
import { verifiedSessionFromContext } from "./auth.js";
import {
  pgRecordFundingClaim,
  pgListFundingClaims,
  pgLatestReceipts,
  pgRecordFundingReceipt,
  type FundingClaim,
} from "./sponsor-funding-pg.js";
import {
  summarizeFunding,
  verifySponsorFunding,
  type ChainReader,
  type FundingReceipt,
} from "./funding-verification.js";

/**
 * The chain reader, awaited.
 *
 * The routes are async, so they can await the module: the awkwardness of a
 * synchronous reader factory is not worth carrying into every caller. A
 * deployment with no arena address or no RPC has no chain, and says so
 * rather than inventing one.
 */
export async function resolveChainReader(): Promise<ChainReader | null> {
  const arenaAddress = process.env.ARENA_ADDRESS?.trim();
  const rpcUrl =
    process.env.MAINNET_RPC_URL?.trim() ||
    process.env.TESTNET_RPC_URL?.trim() ||
    process.env.RPC_URL?.trim();
  if (!arenaAddress || !rpcUrl) return null;
  const { createArenaChainReader } = await import("./chain-reader.js");
  return createArenaChainReader({ rpcUrl, arenaAddress });
}

/** The caller's principal, or a 401/403 response. Membership is server-side. */
function principalOrDenied(c: Context, tenantId: string): { ok: boolean; denied?: Response } {
  const session = verifiedSessionFromContext(c);
  if (!session) {
    return { ok: false, denied: c.json({ error: "unauthenticated", code: "no-credential" }, 401) };
  }
  if (!isMemberOf(session.payload.address.toLowerCase(), tenantId)) {
    return {
      ok: false,
      denied: c.json(
        {
          error: "forbidden",
          reason: `${session.payload.address} is not a member of ${tenantId}`,
          code: "not-a-member",
        },
        403,
      ),
    };
  }
  return { ok: true };
}

/** A receipt rendered for the API: the chain's words and numbers. */
function jsonReceipt(receipt: FundingReceipt | Record<string, unknown>) {
  return {
    trialId: receipt.trialId,
    verdict: receipt.verdict,
    reason: receipt.reason,
    claimedWei: receipt.claimedWei,
    observedSponsorFundingWei: receipt.observedSponsorFundingWei,
    observedRewardWei: receipt.observedRewardWei,
    observedFeeWei: receipt.observedFeeWei,
    observedDepositedWei: receipt.observedDepositedWei,
    observedPaidOutWei: receipt.observedPaidOutWei,
    observedSponsor: receipt.observedSponsor,
    trialStatus: receipt.trialStatus,
    checkedAt: receipt.checkedAt,
  };
}

function jsonClaim(claim: FundingClaim) {
  return {
    id: claim.id,
    programId: claim.programId,
    trialId: claim.trialId,
    sponsorAddress: claim.sponsorAddress,
    claimedWei: claim.claimedWei,
    txHash: claim.txHash,
    status: claim.status,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

export function createSponsorFundingRoutes(): Hono {
  const app = new Hono();

  /**
   * Record what the program claims it funded.
   *
   * The claim is recorded FIRST and verified after, so a claim that the chain
   * contradicts leaves a record. A claim that was never written cannot be
   * reported as false.
   */
  app.post("/programs/:programId/funding/claims", async (c) => {
    const programId = c.req.param("programId");
    const body = await c.req.json<{
      orgId?: string;
      trialId?: string;
      sponsorAddress?: string;
      claimedWei?: string;
      txHash?: string;
    }>();

    const orgId = body.orgId?.trim();
    if (!orgId) return c.json({ error: "orgId is required", code: "bad-request" }, 400);
    const gate = principalOrDenied(c, orgId);
    if (!gate.ok) return gate.denied!;

    const trialId = body.trialId?.trim();
    const sponsorAddress = body.sponsorAddress?.trim();
    const claimedWei = body.claimedWei?.trim();
    if (!trialId || !sponsorAddress || claimedWei === undefined) {
      return c.json(
        { error: "trialId, sponsorAddress and claimedWei are required", code: "bad-request" },
        400,
      );
    }
    if (!/^\d+$/.test(trialId)) {
      return c.json({ error: "trialId must be a whole number", code: "bad-request" }, 400);
    }
    if (!/^\d+$/.test(claimedWei)) {
      return c.json(
        { error: "claimedWei must be an integer number of wei", code: "bad-request" },
        400,
      );
    }

    const claim = await pgRecordFundingClaim({
      programId,
      orgId,
      trialId,
      sponsorAddress,
      claimedWei,
      txHash: body.txHash?.trim() ?? null,
    });

    // Verify straight away when a chain is configured. When there is none the
    // claim stays CLAIMED — an unchecked claim, honestly labelled.
    const reader = await resolveChainReader();
    if (!reader) {
      return c.json(
        {
          claim: jsonClaim(claim),
          receipt: null,
          note: "no chain is configured on this deployment, so this claim is not verified yet",
        },
        201,
      );
    }

    const receipt = await verifySponsorFunding({
      reader,
      trialId: BigInt(trialId),
      sponsorAddress,
      claimedWei: BigInt(claimedWei),
    });
    await pgRecordFundingReceipt(claim.id, receipt);

    return c.json({ claim: jsonClaim(claim), receipt: jsonReceipt(receipt) }, 201);
  });

  /**
   * The program's funding status: what was claimed, what the chain confirmed.
   *
   * Both totals are returned. `verifiedWei` is what the escrow holds;
   * `claimedWei` is what the program says it paid. A console that showed
   * only the first would hide a dispute, and one that showed only the second
   * would hide a shortfall.
   */
  app.get("/programs/:programId/funding", async (c) => {
    const programId = c.req.param("programId");
    const orgId = c.req.query("orgId")?.trim();
    if (!orgId) return c.json({ error: "orgId is required", code: "bad-request" }, 400);
    const gate = principalOrDenied(c, orgId);
    if (!gate.ok) return gate.denied!;

    const claims = await pgListFundingClaims(programId);
    const receipts = await pgLatestReceipts(programId);

    const summary = summarizeFunding(
      receipts.map((receipt) => ({
        trialId: "",
        sponsorAddress: "",
        verdict: receipt.verdict === "VERIFIED" ? "verified" : receipt.verdict === "MISMATCH" ? "mismatch" : "unverifiable",
        reason: receipt.reason,
        claimedWei: null,
        observedSponsorFundingWei: receipt.observedSponsorFundingWei,
        observedRewardWei: receipt.observedRewardWei,
        observedFeeWei: receipt.observedFeeWei,
        observedDepositedWei: receipt.observedDepositedWei,
        observedPaidOutWei: receipt.observedPaidOutWei,
        observedSponsor: receipt.observedSponsor,
        trialStatus: receipt.trialStatus,
        checkedAt: receipt.checkedAt,
      })),
    );

    return c.json({
      programId,
      claims: claims.map(jsonClaim),
      receipts: receipts.map((receipt) => ({
        claimId: receipt.claimId,
        verdict: receipt.verdict,
        reason: receipt.reason,
        observedSponsorFundingWei: receipt.observedSponsorFundingWei,
        observedRewardWei: receipt.observedRewardWei,
        observedFeeWei: receipt.observedFeeWei,
        observedSponsor: receipt.observedSponsor,
        trialStatus: receipt.trialStatus,
        checkedAt: receipt.checkedAt,
      })),
      summary,
    });
  });

  /**
   * Check every claim of a program against the chain, now.
   *
   * The reconciliation job does this on a schedule; this route is for the
   * sponsor who wants to know now rather than in ten minutes.
   */
  app.post("/programs/:programId/funding/verify", async (c) => {
    const programId = c.req.param("programId");
    const body = await c.req.json<{ orgId?: string }>().catch(() => ({}) as { orgId?: string });
    const orgId = c.req.query("orgId")?.trim() ?? body.orgId?.trim();
    if (!orgId) return c.json({ error: "orgId is required", code: "bad-request" }, 400);
    const gate = principalOrDenied(c, orgId);
    if (!gate.ok) return gate.denied!;

    const reader = await resolveChainReader();
    if (!reader) {
      return c.json(
        {
          error: "no chain is configured on this deployment, so nothing can be verified",
          code: "no-chain",
        },
        503,
      );
    }

    const claims = await pgListFundingClaims(programId);
    const checked: Record<string, unknown>[] = [];
    for (const claim of claims) {
      const receipt = await verifySponsorFunding({
        reader,
        trialId: BigInt(claim.trialId),
        sponsorAddress: claim.sponsorAddress,
        claimedWei: BigInt(claim.claimedWei),
      });
      await pgRecordFundingReceipt(claim.id, receipt);
      checked.push({ claimId: claim.id, receipt: jsonReceipt(receipt) });
    }

    return c.json({ programId, checked });
  });

  return app;
}
