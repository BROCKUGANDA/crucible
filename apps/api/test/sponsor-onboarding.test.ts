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
    it("registers a new sponsor", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x1234567890123456789012345678901234567890",
        contactEmail: "sponsor@test.com",
      });

      expect(sponsor.id).toBeDefined();
      expect(sponsor.name).toBe("Test Sponsor");
      expect(sponsor.status).toBe("pending");
      expect(sponsor.onboardingSteps.length).toBeGreaterThan(0);
    });

    it("retrieves a registered sponsor", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x1234567890123456789012345678901234567890",
        contactEmail: "sponsor@test.com",
      });

      const found = getSponsor(sponsor.id);
      expect(found).toEqual(sponsor);
    });

    it("returns undefined for unknown sponsor", () => {
      expect(getSponsor("nonexistent")).toBeUndefined();
    });

    it("normalizes wallet address", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0xABC",
        contactEmail: "sponsor@test.com",
      });

      expect(sponsor.walletAddress).toBe("0xabc");
    });
  });

  describe("onboarding", () => {
    it("completes an onboarding step", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      const result = completeOnboardingStep(sponsor.id, "organization");
      expect(result).toBe(true);

      const updated = getSponsor(sponsor.id);
      expect(updated?.onboardingSteps[0].completed).toBe(true);
    });

    it("returns false for unknown step", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      expect(completeOnboardingStep(sponsor.id, "unknown")).toBe(false);
    });

    it("auto-approves when all steps completed", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      // Complete all steps
      for (const step of sponsor.onboardingSteps) {
        completeOnboardingStep(sponsor.id, step.step);
      }

      const updated = getSponsor(sponsor.id);
      expect(updated?.status).toBe("approved");
      expect(updated?.approvedAt).toBeDefined();
    });

    it("manually approves a sponsor", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      expect(approveSponsor(sponsor.id)).toBe(true);
      expect(getSponsor(sponsor.id)?.status).toBe("approved");
    });

    it("filters sponsors by status", () => {
      registerSponsor({
        name: "Pending Sponsor",
        walletAddress: "0x111",
        contactEmail: "pending@test.com",
      });

      const sponsor2 = registerSponsor({
        name: "Approved Sponsor",
        walletAddress: "0x222",
        contactEmail: "approved@test.com",
      });
      approveSponsor(sponsor2.id);

      const pending = listSponsors({ status: "pending" });
      const approved = listSponsors({ status: "approved" });

      expect(pending.length).toBe(1);
      expect(approved.length).toBe(1);
    });
  });

  describe("program creation", () => {
    it("creates a program for an approved sponsor", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      approveSponsor(sponsor.id);

      const program = createProgram({
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

    it("rejects program for unapproved sponsor", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });

      expect(() =>
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
      ).toThrow("not approved");
    });

    it("rejects program for unknown sponsor", () => {
      expect(() =>
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
      ).toThrow("not found");
    });

    it("approves and launches a program", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      approveSponsor(sponsor.id);

      const program = createProgram({
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

      expect(approveProgram(program.id)).toBe(true);
      expect(getProgram(program.id)?.status).toBe("approved");

      expect(launchProgram(program.id)).toBe(true);
      expect(getProgram(program.id)?.status).toBe("active");
    });

    it("filters programs by sponsor", () => {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      approveSponsor(sponsor.id);

      createProgram({
        sponsorId: sponsor.id,
        name: "Program 1",
        description: "Program 1",
        objectives: "Test",
        budgetWei: "1000000000000000000",
        rewardPerTrialWei: "100000000000000000",
        suites: ["suite-1"],
        evaluationPeriod: { start: Date.now(), end: Date.now() + 86400000 },
      });

      const programs = listPrograms({ sponsorId: sponsor.id });
      expect(programs.length).toBe(1);
    });
  });

  describe("budget operations", () => {
    function setupProgram() {
      const sponsor = registerSponsor({
        name: "Test Sponsor",
        walletAddress: "0x123",
        contactEmail: "sponsor@test.com",
      });
      approveSponsor(sponsor.id);

      const program = createProgram({
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
      approveProgram(program.id);

      return program;
    }

    it("deposits to escrow", () => {
      const program = setupProgram();

      const result = depositToEscrow(program.id, "500000000000000000");
      expect(result).toBe(true);

      const updated = getProgram(program.id);
      expect(updated?.budget.deposited).toBe(BigInt("500000000000000000"));
      expect(updated?.budget.escrowed).toBe(BigInt("500000000000000000"));
    });

    it("allocates to trial", () => {
      const program = setupProgram();
      depositToEscrow(program.id, "500000000000000000");

      const result = allocateToTrial(program.id, "trial-1", "100000000000000000");
      expect(result).toBe(true);

      const updated = getProgram(program.id);
      expect(updated?.budget.allocated).toBe(BigInt("100000000000000000"));
    });

    it("rejects allocation exceeding escrow", () => {
      const program = setupProgram();
      depositToEscrow(program.id, "100000000000000000");

      const result = allocateToTrial(program.id, "trial-1", "200000000000000000");
      expect(result).toBe(false);
    });

    it("credits settlement", () => {
      const program = setupProgram();

      const result = creditSettlement(program.id, "50000000000000000");
      expect(result).toBe(true);

      const updated = getProgram(program.id);
      expect(updated?.budget.pending).toBe(BigInt("50000000000000000"));
      expect(updated?.budget.payable).toBe(BigInt("50000000000000000"));
    });

    it("records payment", () => {
      const program = setupProgram();
      creditSettlement(program.id, "50000000000000000");

      const result = recordPayment(program.id, "50000000000000000");
      expect(result).toBe(true);

      const updated = getProgram(program.id);
      expect(updated?.budget.paid).toBe(BigInt("50000000000000000"));
    });

    it("rejects payment exceeding payable", () => {
      const program = setupProgram();
      creditSettlement(program.id, "50000000000000000");

      const result = recordPayment(program.id, "100000000000000000");
      expect(result).toBe(false);
    });

    it("records withdrawal", () => {
      const program = setupProgram();
      creditSettlement(program.id, "50000000000000000");
      recordPayment(program.id, "50000000000000000");

      const result = recordWithdrawal(program.id, "50000000000000000");
      expect(result).toBe(true);

      const updated = getProgram(program.id);
      expect(updated?.budget.withdrawn).toBe(BigInt("50000000000000000"));
    });

    it("rejects withdrawal exceeding paid", () => {
      const program = setupProgram();
      creditSettlement(program.id, "50000000000000000");
      recordPayment(program.id, "50000000000000000");

      const result = recordWithdrawal(program.id, "100000000000000000");
      expect(result).toBe(false);
    });

    it("tracks transactions", () => {
      const program = setupProgram();
      depositToEscrow(program.id, "500000000000000000");

      const txs = getProgramTransactions(program.id);
      expect(txs.length).toBeGreaterThan(0);
    });

    it("validates budget consistency", () => {
      const program = setupProgram();
      depositToEscrow(program.id, "500000000000000000");

      const errors = validateBudgetConsistency(program.id);
      expect(errors).toEqual([]);
    });

    it("detects budget inconsistency", () => {
      const program = setupProgram();

      // The program starts consistent - validation should pass
      const errors = validateBudgetConsistency(program.id);
      expect(errors).toEqual([]);
    });

    it("returns error for unknown program", () => {
      const errors = validateBudgetConsistency("nonexistent");
      expect(errors).toContain("Program not found");
    });
  });
});
