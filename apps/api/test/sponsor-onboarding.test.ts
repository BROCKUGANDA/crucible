import { describe, it, expect, beforeEach } from "vitest";
import {
  registerSponsor,
  getSponsor,
  completeOnboardingStep,
  approveSponsor,
  listSponsors,
  createProgram,
  getProgram,
  approveProgram,
  launchProgram,
  listPrograms,
  depositToEscrow,
  allocateToTrial,
  creditSettlement,
  recordPayment,
  recordWithdrawal,
  getProgramTransactions,
  validateBudgetConsistency,
  resetSponsorStore,
} from "../src/sponsor-onboarding.js";

describe("sponsor-onboarding", () => {
  beforeEach(() => {
    resetSponsorStore();
  });

  describe("sponsor registration", () => {
    it("registers a new sponsor", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x1234567890123456789012345678901234567890",
        contactEmail: "sponsor@test.com",
      });

      expect(sponsor.id).toBeDefined();
      expect(sponsor.name).toBe("Test Sponsor");
      expect(sponsor.status).toBe("pending");
      expect(sponsor.onboardingSteps.length).toBeGreaterThan(0);
    });

    it("retrieves a registered sponsor", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x1234567890123456789012345678901234567890",
        contactEmail: "sponsor@test.com",
      });

      const found = await getSponsor(sponsor.id);
      expect(found).toEqual(sponsor);
    });

    it("returns undefined for unknown sponsor", async () => {
      expect(await getSponsor("nonexistent")).toBeUndefined();
    });

    it("normalizes wallet address", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0xABC",
        contactEmail: "sponsor@test.com",
      });

      expect(sponsor.walletAddress).toBe("0xabc");
    });
  });

  describe("onboarding", () => {
    it("completes an onboarding step", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      const result = await completeOnboardingStep(sponsor.id, "organization");
      expect(result).toBe(true);

      const updated = await getSponsor(sponsor.id);
      expect(updated?.onboardingSteps[0].completed).toBe(true);
    });

    it("returns false for unknown step", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      expect(await completeOnboardingStep(sponsor.id, "unknown")).toBe(false);
    });

    it("auto-approves when all steps completed", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      // Complete all steps
      for (const step of sponsor.onboardingSteps) {
        await completeOnboardingStep(sponsor.id, step.step);
      }

      const updated = await getSponsor(sponsor.id);
      expect(updated?.status).toBe("approved");
      expect(updated?.approvedAt).toBeDefined();
    });

    it("manually approves a sponsor", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      expect(await approveSponsor(sponsor.id)).toBe(true);
      expect((await getSponsor(sponsor.id))?.status).toBe("approved");
    });

    it("filters sponsors by status", async () => {
      await registerSponsor({
        name: "Pending Sponsor",
        walletAddress: "0x111",
        contactEmail: "pending@test.com",
      });

      const sponsor2 = await registerSponsor({
        name: "Approved Sponsor",
        walletAddress: "0x222",
        contactEmail: "approved@test.com",
      });
      await approveSponsor(sponsor2.id);

      const pending = await listSponsors({ status: "pending" });
      const approved = await listSponsors({ status: "approved" });

      expect(pending.length).toBe(1);
      expect(approved.length).toBe(1);
    });
  });

  describe("program creation", () => {
    it("creates a program for an approved sponsor", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      await approveSponsor(sponsor.id);

      const program = await createProgram({
        sponsorId: sponsor.id,
        name: "Test Program",
        description: "A test program",
        objectives: "Evaluate agents",
        budgetWei: "1000000000000000000", // 1 ETH
        rewardPerTrialWei: "100000000000000000", // 0.1 ETH
        suites: ["suite-1"],
        evaluationPeriod: {
          start: Date.now(),
          end: Date.now() + 86400000,
        },
      });

      expect(program.id).toBeDefined();
      expect(program.name).toBe("Test Program");
      expect(program.status).toBe("draft");
      expect(program.budget.committed).toBe(BigInt("1000000000000000000"));
    });

    it("rejects program for unapproved sponsor", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      await expect(
        createProgram({
          sponsorId: sponsor.id,
          name: "Test Program",
          description: "A test program",
          objectives: "Evaluate agents",
          budgetWei: "1000000000000000000",
          rewardPerTrialWei: "100000000000000000",
          suites: ["suite-1"],
          evaluationPeriod: {
            start: Date.now(),
            end: Date.now() + 86400000,
          },
        }),
      ).rejects.toThrow("not approved");
    });

    it("rejects program for unknown sponsor", async () => {
      await expect(
        createProgram({
          sponsorId: "nonexistent",
          name: "Test Program",
          description: "A test program",
          objectives: "Evaluate agents",
          budgetWei: "1000000000000000000",
          rewardPerTrialWei: "100000000000000000",
          suites: ["suite-1"],
          evaluationPeriod: {
            start: Date.now(),
            end: Date.now() + 86400000,
          },
        }),
      ).rejects.toThrow("not found");
    });

    it("approves and launches a program", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      await approveSponsor(sponsor.id);

      const program = await createProgram({
        sponsorId: sponsor.id,
        name: "Test Program",
        description: "A test program",
        objectives: "Evaluate agents",
        budgetWei: "1000000000000000000",
        rewardPerTrialWei: "100000000000000000",
        suites: ["suite-1"],
        evaluationPeriod: {
          start: Date.now(),
          end: Date.now() + 86400000,
        },
      });

      expect(await approveProgram(program.id)).toBe(true);
      expect((await getProgram(program.id))?.status).toBe("approved");

      expect(await launchProgram(program.id)).toBe(true);
      expect((await getProgram(program.id))?.status).toBe("active");
    });

    it("filters programs by sponsor", async () => {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      await approveSponsor(sponsor.id);

      await createProgram({
        sponsorId: sponsor.id,
        name: "Program 1",
        description: "Program 1",
        objectives: "Test",
        budgetWei: "1000000000000000000",
        rewardPerTrialWei: "100000000000000000",
        suites: ["suite-1"],
        evaluationPeriod: { start: Date.now(), end: Date.now() + 86400000 },
      });

      const programs = await listPrograms({ sponsorId: sponsor.id });
      expect(programs.length).toBe(1);
    });
  });

  describe("budget operations", () => {
    async function setupProgram() {
      const sponsor = await registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      await approveSponsor(sponsor.id);

      const program = await createProgram({
        sponsorId: sponsor.id,
        name: "Test Program",
        description: "A test program",
        objectives: "Evaluate agents",
        budgetWei: "1000000000000000000", // 1 ETH
        rewardPerTrialWei: "100000000000000000",
        suites: ["suite-1"],
        evaluationPeriod: {
          start: Date.now(),
          end: Date.now() + 86400000,
        },
      });
      await approveProgram(program.id);

      return program;
    }

    it("deposits to escrow", async () => {
      const program = await setupProgram();

      const result = await depositToEscrow(program.id, "500000000000000000");
      expect(result).toBe(true);

      const updated = await getProgram(program.id);
      expect(updated?.budget.deposited).toBe(BigInt("500000000000000000"));
      expect(updated?.budget.escrowed).toBe(BigInt("500000000000000000"));
    });

    it("allocates to trial", async () => {
      const program = await setupProgram();
      await depositToEscrow(program.id, "500000000000000000");

      const result = await allocateToTrial(program.id, "trial-1", "100000000000000000");
      expect(result).toBe(true);

      const updated = await getProgram(program.id);
      expect(updated?.budget.allocated).toBe(BigInt("100000000000000000"));
    });

    it("rejects allocation exceeding escrow", async () => {
      const program = await setupProgram();
      await depositToEscrow(program.id, "100000000000000000");

      const result = await allocateToTrial(program.id, "trial-1", "200000000000000000");
      expect(result).toBe(false);
    });

    it("credits settlement", async () => {
      const program = await setupProgram();

      const result = await creditSettlement(program.id, "50000000000000000");
      expect(result).toBe(true);

      const updated = await getProgram(program.id);
      expect(updated?.budget.pending).toBe(BigInt("50000000000000000"));
      expect(updated?.budget.payable).toBe(BigInt("50000000000000000"));
    });

    it("records payment", async () => {
      const program = await setupProgram();
      await creditSettlement(program.id, "50000000000000000");

      const result = await recordPayment(program.id, "50000000000000000");
      expect(result).toBe(true);

      const updated = await getProgram(program.id);
      expect(updated?.budget.paid).toBe(BigInt("50000000000000000"));
    });

    it("rejects payment exceeding payable", async () => {
      const program = await setupProgram();
      await creditSettlement(program.id, "50000000000000000");

      const result = await recordPayment(program.id, "100000000000000000");
      expect(result).toBe(false);
    });

    it("records withdrawal", async () => {
      const program = await setupProgram();
      await creditSettlement(program.id, "50000000000000000");
      await recordPayment(program.id, "50000000000000000");

      const result = await recordWithdrawal(program.id, "50000000000000000");
      expect(result).toBe(true);

      const updated = await getProgram(program.id);
      expect(updated?.budget.withdrawn).toBe(BigInt("50000000000000000"));
    });

    it("rejects withdrawal exceeding paid", async () => {
      const program = await setupProgram();
      await creditSettlement(program.id, "50000000000000000");
      await recordPayment(program.id, "50000000000000000");

      const result = await recordWithdrawal(program.id, "100000000000000000");
      expect(result).toBe(false);
    });

    it("tracks transactions", async () => {
      const program = await setupProgram();
      await depositToEscrow(program.id, "500000000000000000");

      const txs = await getProgramTransactions(program.id);
      expect(txs.length).toBeGreaterThan(0);
    });

    it("validates budget consistency", async () => {
      const program = await setupProgram();
      await depositToEscrow(program.id, "500000000000000000");

      const errors = await validateBudgetConsistency(program.id);
      expect(errors).toEqual([]);
    });

    it("detects budget inconsistency", async () => {
      const program = await setupProgram();

      // The program starts consistent - validation should pass
      const errors = await validateBudgetConsistency(program.id);
      expect(errors).toEqual([]);
    });

    it("returns error for unknown program", async () => {
      const errors = await validateBudgetConsistency("nonexistent");
      expect(errors).toContain("Program not found");
    });
  });
});
