/**
 * @file forge.test.ts — Adaptive Forge API route tests.
 *
 * Tests the Forge Brief, difficulty, bounty adequacy, and Campaign routes.
 * All routes are organisation-scoped and require an authenticated wallet
 * principal with organisation membership.
 */

// The auth routes fail closed: a missing secret means no session is signed.
// The test therefore asks for the development behaviour by name.
process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app.js";
import {
  createOrganisation,
  createMembership,
  newOrganisation,
  newMembership,
  __resetForgeStoreForTests,
} from "@crucible/agent-security";
import { emptyModel } from "@crucible/indexer";

// The auth routes fail closed: a missing secret means no session is signed.
// The test therefore asks for the development behaviour by name.
process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

const OWNER = `0x${"11".repeat(20)}`;
const STRANGER = `0x${"33".repeat(20)}`;
const ORG_ID = "org-test";
const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

// Seed an organisation with the owner as a member so authz checks pass.
// createOrganisation auto-creates the owner membership with the eip155-format
// principal id that buildOrganisationPrincipal produces.
const ownerPrincipalId = `eip155:31337:${OWNER.toLowerCase()}`;
const testOrg = newOrganisation(ORG_ID, "Test Org", "test-org", ownerPrincipalId);
createOrganisation(testOrg);

/** Build a Hono request with a SIUE session cookie for a wallet address. */
function sessionHeaders(address: string): Headers {
  const now = Date.now();
  const payload = {
    address,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 7,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from(
    createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url"),
  ).toString("base64url");
  const token = `${encoded}.${sig}`;
  return new Headers({
    cookie: `crucible_session=${token}`,
    "content-type": "application/json",
  });
}

function appWith() {
  return createApp(
    {
      getModel: () => emptyModel(),
    },
    { rateLimit: false },
  );
}

afterEach(() => {
  __resetForgeStoreForTests();
});

describe("Forge Brief routes", () => {
  it("creates a brief and returns a readiness report", async () => {
    const app = appWith();
    const res = await app.request("/forge/brief", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "Reconcile ledgers",
        domain: "finance",
        problemStatement: "Reconcile two transaction datasets.",
        intendedOutcome: "A reconciliation report.",
        expectedDeliverable: "Report PDF.",
        purpose: "Financial accuracy.",
        whyItMatters: "Compliance.",
        requirements: [
          {
            id: "req-1",
            text: "Detect duplicates.",
            mandatory: true,
            acceptanceCriteria: ["All duplicates are flagged."],
            validationConditions: ["Run on test dataset."],
            requiredEvidence: ["Report."],
          },
        ],
        verification: { deterministicTestSuite: true },
        financialCommitment: {
          nativeAsset: "ETH",
          network: "31337",
          proposedRewardWei: "50000000000000000", // 0.05 ETH
        },
        reliabilityAndRisk: {
          deadlineMs: Date.now() + 86400000,
        },
        complexity: {
          ambiguity: "low",
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brief.briefId).toBeDefined();
    expect(body.brief.status).toBe("ready_to_fund");
    expect(body.readiness.status).toBe("ready_to_fund");
    expect(body.readiness.failures).toHaveLength(0);
  });

  it("rejects unauthenticated callers", async () => {
    const app = appWith();
    const res = await app.request("/forge/brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: ORG_ID, title: "T" }),
    });
    expect(res.status).toBe(401);
  });

  it("gets a brief by ID", async () => {
    const app = appWith();
    const createRes = await app.request("/forge/brief", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "T",
        domain: "d",
        problemStatement: "p",
        intendedOutcome: "o",
        expectedDeliverable: "e",
        purpose: "p",
        whyItMatters: "w",
        verification: { deterministicTestSuite: true },
        financialCommitment: {
          nativeAsset: "ETH",
          network: "31337",
          proposedRewardWei: "50000000000000000",
        },
      }),
    });
    const { brief } = await createRes.json();
    const briefId = brief.briefId;

    const getRes = await app.request(
      `/forge/brief/${briefId}?orgId=${ORG_ID}`,
      {
        method: "GET",
        headers: sessionHeaders(OWNER),
      },
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.brief.briefId).toBe(briefId);
  });

  it("validates a brief", async () => {
    const app = appWith();
    const createRes = await app.request("/forge/brief", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "T",
        domain: "d",
        problemStatement: "p",
        intendedOutcome: "o",
        expectedDeliverable: "e",
        purpose: "p",
        whyItMatters: "w",
        requirements: [
          {
            id: "req-1",
            text: "t",
            mandatory: true,
            acceptanceCriteria: ["c"],
            validationConditions: ["c"],
          },
        ],
        verification: { deterministicTestSuite: true },
        financialCommitment: {
          nativeAsset: "ETH",
          network: "31337",
          proposedRewardWei: "50000000000000000",
        },
      }),
    });
    const { brief } = await createRes.json();

    const valRes = await app.request(
      `/forge/brief/${brief.briefId}/validate`,
      {
        method: "POST",
        headers: sessionHeaders(OWNER),
        body: JSON.stringify({ orgId: ORG_ID }),
      },
    );
    expect(valRes.status).toBe(200);
    const valBody = await valRes.json();
    expect(valBody.readiness.status).toBe("ready_to_fund");
  });
});

describe("Bounty adequacy routes", () => {
  it("computes a bounty recommendation", async () => {
    const app = appWith();
    const createRes = await app.request("/forge/brief", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "T",
        domain: "d",
        problemStatement: "p",
        intendedOutcome: "o",
        expectedDeliverable: "e",
        purpose: "p",
        whyItMatters: "w",
        verification: { deterministicTestSuite: true },
        financialCommitment: {
          nativeAsset: "ETH",
          network: "31337",
          proposedRewardWei: "1000000000000000000",
        },
      }),
    });
    const { brief } = await createRes.json();

    const recRes = await app.request(`/forge/bounty/${brief.briefId}`, {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        executionCost: "100000000000000000",
        specialistEffortValue: "200000000000000000",
        complexityPremium: "50000000000000000",
        riskPremium: "30000000000000000",
        scarcityPremium: "20000000000000000",
        protocolFloor: "100000000000000000",
        modelConfidence: 0.8,
        reason: "Test bounty recommendation.",
      }),
    });
    expect(recRes.status).toBe(200);
    const recBody = await recRes.json();
    expect(recBody.recommendation.competitiveBounty).toBeDefined();
    expect(recBody.recommendation.requiredBondWei).toBeDefined();
    expect(recBody.recommendation.protocolFeeWei).toBeDefined();
  });

  it("assesses bounty adequacy", async () => {
    const app = appWith();
    const createRes = await app.request("/forge/brief", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "T",
        domain: "d",
        problemStatement: "p",
        intendedOutcome: "o",
        expectedDeliverable: "e",
        purpose: "p",
        whyItMatters: "w",
        verification: { deterministicTestSuite: true },
        financialCommitment: {
          nativeAsset: "ETH",
          network: "31337",
          proposedRewardWei: "1000000000000000000",
        },
      }),
    });
    const { brief } = await createRes.json();

    // First compute a recommendation
    await app.request(`/forge/bounty/${brief.briefId}`, {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        executionCost: "100000000000000000",
        specialistEffortValue: "200000000000000000",
        complexityPremium: "50000000000000000",
        riskPremium: "30000000000000000",
        scarcityPremium: "20000000000000000",
        protocolFloor: "100000000000000000",
        modelConfidence: 0.8,
        reason: "Test.",
      }),
    });

    // Then assess adequacy
    const adeqRes = await app.request(
      `/forge/bounty/${brief.briefId}/adequacy`,
      {
        method: "POST",
        headers: sessionHeaders(OWNER),
        body: JSON.stringify({
          orgId: ORG_ID,
          sponsorProposedRewardWei: "1500000000000000000", // 1.5 ETH
        }),
      },
    );
    expect(adeqRes.status).toBe(200);
    const adeqBody = await adeqRes.json();
    expect(adeqBody.report.isAdequate).toBeDefined();
    expect(adeqBody.report.adequacyReason).toBeDefined();
  });
});

describe("Forge Campaign routes", () => {
  it("creates a campaign and adds a stage", async () => {
    const app = appWith();
    const campRes = await app.request("/forge/campaign", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "Reconciliation Campaign",
        domain: "finance",
        totalBudgetWei: "1000000000000000000", // 1 ETH
        nativeAsset: "ETH",
        network: "31337",
      }),
    });
    expect(campRes.status).toBe(201);
    const campBody = await campRes.json();
    const campaignId = campBody.campaign.campaignId;
    expect(campaignId).toBeDefined();

    const stageRes = await app.request(
      `/forge/campaign/${campaignId}/stage`,
      {
        method: "POST",
        headers: sessionHeaders(OWNER),
        body: JSON.stringify({
          orgId: ORG_ID,
          stageId: "s1",
          stageNumber: 1,
          title: "Stage 1",
          domain: "finance",
          heat: "kindling",
          requiredSkill: [],
          briefId: "brief-1",
          rewardWei: "500000000000000000",
          nativeAsset: "ETH",
          network: "31337",
          unlockCondition: "manual",
        }),
      },
    );
    expect(stageRes.status).toBe(201);
    const stageBody = await stageRes.json();
    expect(stageBody.campaign.stages).toHaveLength(1);
    expect(stageBody.campaign.stages[0].stageId).toBe("s1");
  });

  it("funds and settles a campaign stage", async () => {
    const app = appWith();
    const campRes = await app.request("/forge/campaign", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "T",
        domain: "d",
        totalBudgetWei: "1000000000000000000",
        nativeAsset: "ETH",
        network: "31337",
      }),
    });
    const { campaign } = await campRes.json();

    const stageRes = await app.request(
      `/forge/campaign/${campaign.campaignId}/stage`,
      {
        method: "POST",
        headers: sessionHeaders(OWNER),
        body: JSON.stringify({
          orgId: ORG_ID,
          stageId: "s1",
          stageNumber: 1,
          title: "S1",
          domain: "d",
          heat: "kindling",
          requiredSkill: [],
          briefId: "b",
          rewardWei: "500000000000000000",
          nativeAsset: "ETH",
          network: "31337",
          status: "open",
          dependsOn: [],
          unlockCondition: "manual",
        }),
      },
    );
    expect(stageRes.status).toBe(201);

    // Fund the stage
    const fundRes = await app.request(
      `/forge/campaign/${campaign.campaignId}/stage/s1/fund`,
      {
        method: "POST",
        headers: sessionHeaders(OWNER),
        body: JSON.stringify({
          orgId: ORG_ID,
          amountWei: "500000000000000000",
        }),
      },
    );
    expect(fundRes.status).toBe(200);

    // Settle the stage
    const settleRes = await app.request(
      `/forge/campaign/${campaign.campaignId}/stage/s1/settle`,
      {
        method: "POST",
        headers: sessionHeaders(OWNER),
        body: JSON.stringify({ orgId: ORG_ID }),
      },
    );
    expect(settleRes.status).toBe(200);
    const settleBody = await settleRes.json();
    expect(settleBody.campaign.stages[0].status).toBe("settled");
  });

  it("lists campaigns for an org", async () => {
    const app = appWith();
    await app.request("/forge/campaign", {
      method: "POST",
      headers: sessionHeaders(OWNER),
      body: JSON.stringify({
        orgId: ORG_ID,
        title: "T",
        domain: "d",
        totalBudgetWei: "1000000000000000000",
        nativeAsset: "ETH",
        network: "31337",
      }),
    });

    const listRes = await app.request(
      `/forge/campaigns?orgId=${ORG_ID}`,
      {
        method: "GET",
        headers: sessionHeaders(OWNER),
      },
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.campaigns).toHaveLength(1);
  });

  it("rejects unauthenticated callers", async () => {
    const app = appWith();
    const res = await app.request("/forge/campaigns", {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
