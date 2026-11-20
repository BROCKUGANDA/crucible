/**
 * @file sponsor-routes.ts — Hono routes for sponsor onboarding and programs.
 *
 * Provides sponsor registration, program creation, budget management,
 * and three-truth model enforcement.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
import type { BudgetTransaction, SponsorOrg, SponsorProgram } from "./sponsor-onboarding.js";
import {
  registerSponsor,
  getSponsor,
  listSponsors,
  completeOnboardingStep,
  approveSponsor,
  createProgram,
  getProgram,
  approveProgram,
  launchProgram,
  listPrograms,
  depositToEscrow,
  allocateToTrial,
  recordPayment,
  recordWithdrawal,
  getProgramTransactions,
  validateBudgetConsistency,
} from "./sponsor-onboarding.js";

/**
 * A sponsor as the API serves it.
 *
 * The domain holds wei as `bigint`. JSON has no bigint, and
 * `JSON.stringify` throws on one rather than rounding it — so every wei
 * leaves as a decimal string. A wei that crossed a float would be wrong by
 * more than it sounds like.
 */
function jsonSponsor(sponsor: SponsorOrg) {
  return {
    id: sponsor.id,
    orgId: sponsor.orgId,
    name: sponsor.name,
    walletAddress: sponsor.walletAddress,
    contactEmail: sponsor.contactEmail,
    status: sponsor.status,
    onboardingSteps: sponsor.onboardingSteps,
    createdAt: sponsor.createdAt,
    approvedAt: sponsor.approvedAt ?? null,
  };
}

/** A programme as the API serves it: wei as strings, everything else as it is. */
function jsonProgram(program: SponsorProgram) {
  return {
    id: program.id,
    orgId: program.orgId,
    sponsorId: program.sponsorId,
    name: program.name,
    description: program.description,
    objectives: program.objectives,
    status: program.status,
    budget: {
      committed: program.budget.committed.toString(),
      deposited: program.budget.deposited.toString(),
      escrowed: program.budget.escrowed.toString(),
      allocated: program.budget.allocated.toString(),
      pending: program.budget.pending.toString(),
      payable: program.budget.payable.toString(),
      paid: program.budget.paid.toString(),
      withdrawn: program.budget.withdrawn.toString(),
    },
    eligibility: program.eligibility,
    rewardStructure: {
      rewardPerTrial: program.rewardStructure.rewardPerTrial.toString(),
      topPerformerBonus: program.rewardStructure.topPerformerBonus?.toString() ?? null,
      safetyPenalty: program.rewardStructure.safetyPenalty?.toString() ?? null,
    },
    suites: program.suites,
    evaluationPeriod: program.evaluationPeriod,
    disputeRules: program.disputeRules,
    publicationPolicy: program.publicationPolicy,
    createdAt: program.createdAt,
    approvedAt: program.approvedAt ?? null,
    launchedAt: program.launchedAt ?? null,
    completedAt: program.completedAt ?? null,
  };
}

/** A budget entry as the API serves it: the amount as a string of wei. */
function jsonEntry(entry: BudgetTransaction) {
  return {
    id: entry.id,
    programId: entry.programId,
    state: entry.state,
    amount: entry.amount.toString(),
    description: entry.description,
    createdAt: entry.createdAt,
  };
}

export function createSponsorRoutes(): Hono {
  const app = new Hono();

  // List sponsors
  app.get("/", async (c) => {
    const status = c.req.query("status");
    const sponsors = await listSponsors({ status: status as any });
    return c.json(sponsors.map(jsonSponsor));
  });

  // Register a new sponsor
  app.post("/", async (c) => {
    const input = await c.req.json<{ name: string; walletAddress: string; contactEmail: string }>();
    try {
      const sponsor = await registerSponsor(input);
      return c.json(jsonSponsor(sponsor), 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get sponsor by ID
  app.get("/:sponsorId", async (c) => {
    const sponsorId = c.req.param("sponsorId");
    const sponsor = await getSponsor(sponsorId);
    if (!sponsor) return c.json({ error: "Sponsor not found" }, 404);
    return c.json(jsonSponsor(sponsor));
  });

  // Complete onboarding step
  app.post("/:sponsorId/onboarding/:step", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const sponsorId = c.req.param("sponsorId");
    const step = c.req.param("step");
    const success = await completeOnboardingStep(sponsorId, step);
    if (!success) return c.json({ error: "Step not found or already completed" }, 400);
    return c.json(jsonSponsor((await getSponsor(sponsorId))!));
  });

  // Approve sponsor (admin only)
  app.post("/:sponsorId/approve", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const sponsorId = c.req.param("sponsorId");
    const success = await approveSponsor(sponsorId);
    if (!success) return c.json({ error: "Sponsor cannot be approved" }, 400);
    return c.json(jsonSponsor((await getSponsor(sponsorId))!));
  });

  // List programs for a sponsor
  app.get("/:sponsorId/programs", async (c) => {
    const sponsorId = c.req.param("sponsorId");
    const status = c.req.query("status");
    const programs = await listPrograms({ sponsorId, status: status as any });
    return c.json(programs.map(jsonProgram));
  });

  // Create a new program
  app.post("/:sponsorId/programs", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const sponsorId = c.req.param("sponsorId");
    const input = await c.req.json<{
      name: string;
      description: string;
      objectives: string;
      budgetWei: string;
      rewardPerTrialWei: string;
      suites: string[];
      evaluationPeriod: { start: number; end: number };
      publicationPolicy?: "public" | "private" | "sponsor-only";
      eligibility?: { maxParticipants?: number; requiredCapabilities?: string[]; allowedAgentTypes?: string[] };
    }>();

    try {
      const program = await createProgram({ ...input, sponsorId });
      return c.json(jsonProgram(program), 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get program by ID
  app.get("/programs/:programId", async (c) => {
    const programId = c.req.param("programId");
    const program = await getProgram(programId);
    if (!program) return c.json({ error: "Program not found" }, 404);
    return c.json(jsonProgram(program));
  });

  // Approve program
  app.post("/programs/:programId/approve", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const success = await approveProgram(programId);
    if (!success) return c.json({ error: "Program cannot be approved" }, 400);
    return c.json(getProgram(programId));
  });

  // Launch program
  app.post("/programs/:programId/launch", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const success = await launchProgram(programId);
    if (!success) return c.json({ error: "Program cannot be launched" }, 400);
    return c.json(getProgram(programId));
  });

  // Deposit to escrow
  app.post("/programs/:programId/deposit", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { amountWei } = await c.req.json<{ amountWei: string }>();
    const success = await depositToEscrow(programId, amountWei);
    if (!success) return c.json({ error: "Deposit failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Allocate to trial
  app.post("/programs/:programId/allocate", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { trialId, amountWei } = await c.req.json<{ trialId: string; amountWei: string }>();
    const success = await allocateToTrial(programId, trialId, amountWei);
    if (!success) return c.json({ error: "Allocation failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Record payment
  app.post("/programs/:programId/payment", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { amountWei } = await c.req.json<{ amountWei: string }>();
    const success = await recordPayment(programId, amountWei);
    if (!success) return c.json({ error: "Payment recording failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Record withdrawal
  app.post("/programs/:programId/withdrawal", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { amountWei } = await c.req.json<{ amountWei: string }>();
    const success = await recordWithdrawal(programId, amountWei);
    if (!success) return c.json({ error: "Withdrawal recording failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Get budget transactions
  app.get("/programs/:programId/transactions", async (c) => {
    const programId = c.req.param("programId");
    const transactions = await getProgramTransactions(programId);
    return c.json(transactions.map(jsonEntry));
  });

  // Validate budget consistency
  app.get("/programs/:programId/validate", async (c) => {
    const programId = c.req.param("programId");
    const errors = await validateBudgetConsistency(programId);
    if (errors.length > 0) {
      return c.json({ valid: false, errors });
    }
    return c.json({ valid: true, errors: [] });
  });

  return app;
}
