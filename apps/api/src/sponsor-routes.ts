/**
 * @file sponsor-routes.ts — Hono routes for sponsor onboarding and programs.
 *
 * Provides sponsor registration, program creation, budget management,
 * and three-truth model enforcement.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
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

export function createSponsorRoutes(): Hono {
  const app = new Hono();

  // List sponsors
  app.get("/", (c) => {
    const status = c.req.query("status");
    const sponsors = listSponsors({ status: status as any });
    return c.json(sponsors);
  });

  // Register a new sponsor
  app.post("/", async (c) => {
    const input = await c.req.json<{ name: string; walletAddress: string; contactEmail: string }>();
    try {
      const sponsor = registerSponsor(input);
      return c.json(sponsor, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get sponsor by ID
  app.get("/:sponsorId", (c) => {
    const sponsorId = c.req.param("sponsorId");
    const sponsor = getSponsor(sponsorId);
    if (!sponsor) return c.json({ error: "Sponsor not found" }, 404);
    return c.json(sponsor);
  });

  // Complete onboarding step
  app.post("/:sponsorId/onboarding/:step", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const sponsorId = c.req.param("sponsorId");
    const step = c.req.param("step");
    const success = completeOnboardingStep(sponsorId, step);
    if (!success) return c.json({ error: "Step not found or already completed" }, 400);
    return c.json(getSponsor(sponsorId));
  });

  // Approve sponsor (admin only)
  app.post("/:sponsorId/approve", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const sponsorId = c.req.param("sponsorId");
    const success = approveSponsor(sponsorId);
    if (!success) return c.json({ error: "Sponsor cannot be approved" }, 400);
    return c.json(getSponsor(sponsorId));
  });

  // List programs for a sponsor
  app.get("/:sponsorId/programs", (c) => {
    const sponsorId = c.req.param("sponsorId");
    const status = c.req.query("status");
    const programs = listPrograms({ sponsorId, status: status as any });
    return c.json(programs);
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
      const program = createProgram({ ...input, sponsorId });
      return c.json(program, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get program by ID
  app.get("/programs/:programId", (c) => {
    const programId = c.req.param("programId");
    const program = getProgram(programId);
    if (!program) return c.json({ error: "Program not found" }, 404);
    return c.json(program);
  });

  // Approve program
  app.post("/programs/:programId/approve", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const success = approveProgram(programId);
    if (!success) return c.json({ error: "Program cannot be approved" }, 400);
    return c.json(getProgram(programId));
  });

  // Launch program
  app.post("/programs/:programId/launch", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const success = launchProgram(programId);
    if (!success) return c.json({ error: "Program cannot be launched" }, 400);
    return c.json(getProgram(programId));
  });

  // Deposit to escrow
  app.post("/programs/:programId/deposit", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { amountWei } = await c.req.json<{ amountWei: string }>();
    const success = depositToEscrow(programId, amountWei);
    if (!success) return c.json({ error: "Deposit failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Allocate to trial
  app.post("/programs/:programId/allocate", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { trialId, amountWei } = await c.req.json<{ trialId: string; amountWei: string }>();
    const success = allocateToTrial(programId, trialId, amountWei);
    if (!success) return c.json({ error: "Allocation failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Record payment
  app.post("/programs/:programId/payment", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { amountWei } = await c.req.json<{ amountWei: string }>();
    const success = recordPayment(programId, amountWei);
    if (!success) return c.json({ error: "Payment recording failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Record withdrawal
  app.post("/programs/:programId/withdrawal", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const programId = c.req.param("programId");
    const { amountWei } = await c.req.json<{ amountWei: string }>();
    const success = recordWithdrawal(programId, amountWei);
    if (!success) return c.json({ error: "Withdrawal recording failed" }, 400);
    return c.json(getProgram(programId));
  });

  // Get budget transactions
  app.get("/programs/:programId/transactions", (c) => {
    const programId = c.req.param("programId");
    const transactions = getProgramTransactions(programId);
    return c.json(transactions);
  });

  // Validate budget consistency
  app.get("/programs/:programId/validate", (c) => {
    const programId = c.req.param("programId");
    const errors = validateBudgetConsistency(programId);
    if (errors.length > 0) {
      return c.json({ valid: false, errors });
    }
    return c.json({ valid: true, errors: [] });
  });

  return app;
}
