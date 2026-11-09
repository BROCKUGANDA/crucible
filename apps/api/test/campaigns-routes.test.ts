/**
 * @file campaigns-routes.test.ts — the campaign routes derive eligibility
 * signals from authoritative state, never from the request body.
 *
 * Covers: client-supplied signals are ignored (fail closed), the configured
 * signals provider decides, and passport-gated campaigns read the passport
 * signal from the provider.
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import type { Hono } from "hono";
import { createCampaignRoutes, type CampaignEligibilitySignals } from "../src/campaigns-routes";
import { CampaignDistributor, type EligibilityCriterion } from "../src/campaigns";

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";
const WALLET = "0x1111111111111111111111111111111111111111";
const CAMPAIGN_SPONSOR = "0x9999999999999999999999999999999999999999";

function sessionHeaders(address: string): Headers {
  const now = Date.now();
  const payload = {
    address,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 7,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return new Headers({
    cookie: `__Host-crucible_session=${encoded}.${sig}`,
    "content-type": "application/json",
  });
}

interface Harness {
  app: Hono;
  campaignId: string;
  distributor: CampaignDistributor;
}

function harness(options: {
  eligibility?: EligibilityCriterion[];
  requirePassport?: boolean;
  minPassportScore?: number;
  signals?: (wallet: string) => Promise<CampaignEligibilitySignals> | CampaignEligibilitySignals;
} = {}): Harness {
  const distributor = new CampaignDistributor();
  const campaign = distributor.createCampaign({
    name: "Signals Test",
    description: "",
    sponsor: CAMPAIGN_SPONSOR,
    assetType: "token",
    assetSymbol: "TEST",
    totalBudget: 1000n,
    perClaimAmount: 10n,
    maxClaimsPerWallet: 1,
    startsAt: Date.now() - 1_000,
    endsAt: Date.now() + 86_400_000,
    eligibility: options.eligibility ?? [],
    requirePassport: options.requirePassport,
    minPassportScore: options.minPassportScore,
  });
  distributor.updateCampaignStatus(campaign.campaignId, "active");
  const app = createCampaignRoutes({ distributor, signals: options.signals });
  return { app, campaignId: campaign.campaignId, distributor };
}

describe("campaign routes: eligibility signals are server-derived", () => {
  it("security: a client-supplied trialCount is ignored — an unknown wallet cannot claim by asserting one", async () => {
    const { app, campaignId } = harness({
      eligibility: [{ type: "trial_count", operator: "gte", value: 3 }],
    });
    const res = await app.request(`/${campaignId}/claim`, {
      method: "POST",
      headers: sessionHeaders(WALLET),
      body: JSON.stringify({ trialCount: 99, walletAge: 999, reputation: 100 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("not_eligible");
  });

  it("security: the eligibility endpoint reports the server-derived verdict, not the caller's claim", async () => {
    const { app, campaignId } = harness({
      eligibility: [{ type: "trial_count", operator: "gte", value: 3 }],
    });
    const res = await app.request(`/${campaignId}/eligibility`, {
      method: "POST",
      headers: sessionHeaders(WALLET),
      body: JSON.stringify({ trialCount: 99 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eligible).toBe(false);
  });

  it("a wallet the signals provider vouches for can claim, whatever the body says", async () => {
    const signals = vi.fn(
      (wallet: string): CampaignEligibilitySignals => {
        expect(wallet.toLowerCase()).toBe(WALLET.toLowerCase());
        return { trialCount: 5 };
      },
    );
    const { app, campaignId } = harness({
      eligibility: [{ type: "trial_count", operator: "gte", value: 3 }],
      signals,
    });
    const res = await app.request(`/${campaignId}/claim`, {
      method: "POST",
      headers: sessionHeaders(WALLET),
      body: JSON.stringify({ trialCount: 0 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.claim.status).toBe("pending");
    expect(signals).toHaveBeenCalledOnce();
  });

  it("with no signals provider, a signal-dependent criterion fails closed", async () => {
    const { app, campaignId } = harness({
      eligibility: [{ type: "reputation_min", operator: "gte", value: 1 }],
    });
    const res = await app.request(`/${campaignId}/claim`, {
      method: "POST",
      headers: sessionHeaders(WALLET),
      body: JSON.stringify({ reputation: 50 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("not_eligible");
  });

  it("passport-gated campaigns read the passport signal from the provider, not the body", async () => {
    const gated = { requirePassport: true, minPassportScore: 0.5 };

    const without = harness(gated);
    const refused = await without.app.request(`/${without.campaignId}/claim`, {
      method: "POST",
      headers: sessionHeaders(WALLET),
      body: JSON.stringify({ passportSignal: { eligible: true, sanctioned: false, score: 0.9, method: "passport" } }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("none provided");

    const withProvider = harness({
      ...gated,
      signals: () => ({
        passportSignal: { eligible: true, sanctioned: false, score: 0.9, method: "passport" },
      }),
    });
    const ok = await withProvider.app.request(`/${withProvider.campaignId}/claim`, {
      method: "POST",
      headers: sessionHeaders(WALLET),
      body: JSON.stringify({}),
    });
    expect(ok.status).toBe(201);
  });
});
