/**
 * @file sponsor-onboarding.ts — Sponsor onboarding and program management (Phase 8).
 *
 * Implements the sponsor workflow:
 * - Sponsor registration and onboarding
 * - Program creation with budget caps
 * - Budget accounting (committed, deposited, escrowed, allocated, pending, payable, paid, withdrawn)
 * - Three-truth accounting model (evaluation, commercial, chain)
 * - Pilot administration
 *
 * Every monetary value uses exact integer arithmetic (wei), never JavaScript floats.
 */

import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type SponsorStatus = "pending" | "approved" | "active" | "suspended" | "completed";
export type ProgramStatus = "draft" | "approved" | "active" | "paused" | "completed" | "cancelled";
export type BudgetState =
  | "committed"
  | "deposited"
  | "escrowed"
  | "allocated"
  | "pending"
  | "payable"
  | "paid"
  | "withdrawn";

export interface SponsorOrg {
  id: string;
  name: string;
  walletAddress: string;
  contactEmail: string;
  status: SponsorStatus;
  onboardingSteps: OnboardingStep[];
  createdAt: number;
  approvedAt?: number;
}

export interface OnboardingStep {
  step: string;
  description: string;
  completed: boolean;
  completedAt?: number;
}

export interface SponsorProgram {
  id: string;
  sponsorId: string;
  name: string;
  description: string;
  objectives: string;
  status: ProgramStatus;
  budget: ProgramBudget;
  eligibility: EligibilityConfig;
  rewardStructure: RewardStructure;
  suites: string[];
  evaluationPeriod: EvaluationPeriod;
  disputeRules: string;
  publicationPolicy: "public" | "private" | "sponsor-only";
  createdAt: number;
  approvedAt?: number;
  launchedAt?: number;
  completedAt?: number;
}

export interface ProgramBudget {
  /** Total committed budget in wei. */
  committed: bigint;
  /** Amount deposited to escrow in wei. */
  deposited: bigint;
  /** Amount currently in escrow in wei. */
  escrowed: bigint;
  /** Amount allocated to trials in wei. */
  allocated: bigint;
  /** Amount pending settlement in wei. */
  pending: bigint;
  /** Amount payable but not yet paid in wei. */
  payable: bigint;
  /** Amount paid out in wei. */
  paid: bigint;
  /** Amount withdrawn by recipients in wei. */
  withdrawn: bigint;
}

export interface EligibilityConfig {
  /** Agent participation limits. */
  maxParticipants?: number;
  /** Required agent capabilities. */
  requiredCapabilities?: string[];
  /** Allowed agent types. */
  allowedAgentTypes?: string[];
}

export interface RewardStructure {
  /** Reward per successful trial in wei. */
  rewardPerTrial: bigint;
  /** Bonus for top performers in wei. */
  topPerformerBonus?: bigint;
  /** Safety penalty in wei. */
  safetyPenalty?: bigint;
}

export interface EvaluationPeriod {
  /** Start timestamp. */
  start: number;
  /** End timestamp. */
  end: number;
}

export interface BudgetTransaction {
  id: string;
  programId: string;
  state: BudgetState;
  amount: bigint;
  description: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Defaults                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_ONBOARDING_STEPS: OnboardingStep[] = [
  { step: "organization", description: "Register organization details", completed: false },
  { step: "wallet", description: "Connect and verify wallet", completed: false },
  { step: "identity", description: "Complete identity verification", completed: false },
  { step: "terms", description: "Accept sponsor terms", completed: false },
  { step: "program", description: "Create first program brief", completed: false },
  { step: "funding", description: "Commit initial funding", completed: false },
  { step: "approval", description: "Await program approval", completed: false },
];

/* ------------------------------------------------------------------ */
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

interface SponsorStore {
  sponsors: Map<string, SponsorOrg>;
  programs: Map<string, SponsorProgram>;
  transactions: Map<string, BudgetTransaction[]>;
}

const store: SponsorStore = {
  sponsors: new Map(),
  programs: new Map(),
  transactions: new Map(),
};

/* ------------------------------------------------------------------ */
/* Sponsor operations                                                 */
/* ------------------------------------------------------------------ */

export function registerSponsor(input: {
  name: string;
  walletAddress: string;
  contactEmail: string;
}): SponsorOrg {
  const id = randomUUID();
  const now = Date.now();

  const sponsor: SponsorOrg = {
    id,
    name: input.name.trim(),
    walletAddress: input.walletAddress.toLowerCase().trim(),
    contactEmail: input.contactEmail.toLowerCase().trim(),
    status: "pending",
    onboardingSteps: DEFAULT_ONBOARDING_STEPS.map(s => ({ ...s })),
    createdAt: now,
  };

  store.sponsors.set(id, sponsor);
  return sponsor;
}

export function getSponsor(id: string): SponsorOrg | undefined {
  return store.sponsors.get(id);
}

export function completeOnboardingStep(sponsorId: string, step: string): boolean {
  const sponsor = store.sponsors.get(sponsorId);
  if (!sponsor) return false;

  const stepIdx = sponsor.onboardingSteps.findIndex(s => s.step === step);
  if (stepIdx < 0) return false;

  const stepRef = sponsor.onboardingSteps[stepIdx];
  if (!stepRef) return false;
  stepRef.completed = true;
  stepRef.completedAt = Date.now();
  store.sponsors.set(sponsorId, sponsor);

  // Auto-approve if all steps completed
  const allComplete = sponsor.onboardingSteps.every(s => s.completed);
  if (allComplete && sponsor.status === "pending") {
    sponsor.status = "approved";
    sponsor.approvedAt = Date.now();
    store.sponsors.set(sponsorId, sponsor);
  }

  return true;
}

export function approveSponsor(sponsorId: string): boolean {
  const sponsor = store.sponsors.get(sponsorId);
  if (!sponsor || sponsor.status !== "pending") return false;

  sponsor.status = "approved";
  sponsor.approvedAt = Date.now();
  store.sponsors.set(sponsorId, sponsor);
  return true;
}

export function listSponsors(filters: { status?: SponsorStatus } = {}): SponsorOrg[] {
  const sponsors: SponsorOrg[] = [];
  for (const [, sponsor] of store.sponsors) {
    if (filters.status && sponsor.status !== filters.status) continue;
    sponsors.push(sponsor);
  }
  return sponsors;
}

/* ------------------------------------------------------------------ */
/* Program operations                                                 */
/* ------------------------------------------------------------------ */

export function createProgram(input: {
  sponsorId: string;
  name: string;
  description: string;
  objectives: string;
  budgetWei: string;
  rewardPerTrialWei: string;
  suites: string[];
  evaluationPeriod: EvaluationPeriod;
  publicationPolicy?: "public" | "private" | "sponsor-only";
  eligibility?: EligibilityConfig;
}): SponsorProgram {
  const sponsor = store.sponsors.get(input.sponsorId);
  if (!sponsor) {
    throw new Error(`Sponsor "${input.sponsorId}" not found`);
  }
  if (sponsor.status !== "approved" && sponsor.status !== "active") {
    throw new Error(`Sponsor "${input.sponsorId}" is not approved`);
  }

  const id = randomUUID();
  const now = Date.now();

  const program: SponsorProgram = {
    id,
    sponsorId: input.sponsorId,
    name: input.name.trim(),
    description: input.description.trim(),
    objectives: input.objectives.trim(),
    status: "draft",
    budget: {
      committed: BigInt(input.budgetWei),
      deposited: BigInt(0),
      escrowed: BigInt(0),
      allocated: BigInt(0),
      pending: BigInt(0),
      payable: BigInt(0),
      paid: BigInt(0),
      withdrawn: BigInt(0),
    },
    eligibility: input.eligibility ?? {},
    rewardStructure: {
      rewardPerTrial: BigInt(input.rewardPerTrialWei),
    },
    suites: input.suites,
    evaluationPeriod: input.evaluationPeriod,
    disputeRules: "Standard 2-of-3 grading with commit/reveal",
    publicationPolicy: input.publicationPolicy ?? "public",
    createdAt: now,
  };

  store.programs.set(id, program);

  // Record initial transaction
  addTransaction(id, "committed", program.budget.committed, "Initial budget committed");

  return program;
}

export function getProgram(id: string): SponsorProgram | undefined {
  return store.programs.get(id);
}

export function approveProgram(programId: string): boolean {
  const program = store.programs.get(programId);
  if (!program || program.status !== "draft") return false;

  program.status = "approved";
  program.approvedAt = Date.now();
  store.programs.set(programId, program);
  return true;
}

export function launchProgram(programId: string): boolean {
  const program = store.programs.get(programId);
  if (!program || program.status !== "approved") return false;

  program.status = "active";
  program.launchedAt = Date.now();
  store.programs.set(programId, program);
  return true;
}

export function listPrograms(filters: {
  sponsorId?: string;
  status?: ProgramStatus;
} = {}): SponsorProgram[] {
  const programs: SponsorProgram[] = [];
  for (const [, program] of store.programs) {
    if (filters.sponsorId && program.sponsorId !== filters.sponsorId) continue;
    if (filters.status && program.status !== filters.status) continue;
    programs.push(program);
  }
  return programs;
}

/* ------------------------------------------------------------------ */
/* Budget operations                                                  */
/* ------------------------------------------------------------------ */

/**
 * Add a budget transaction. Maintains the three-truth model:
 * - Evaluation truth: what happened
 * - Commercial truth: who paid what
 * - Chain truth: what was confirmed on-chain
 */
function addTransaction(
  programId: string,
  state: BudgetState,
  amount: bigint,
  description: string,
): BudgetTransaction {
  const tx: BudgetTransaction = {
    id: randomUUID(),
    programId,
    state,
    amount,
    description,
    createdAt: Date.now(),
  };

  const txs = store.transactions.get(programId) ?? [];
  txs.push(tx);
  store.transactions.set(programId, txs);

  return tx;
}

export function depositToEscrow(programId: string, amountWei: string): boolean {
  const program = store.programs.get(programId);
  if (!program) return false;

  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  // Update budget states
  program.budget.deposited += amount;
  program.budget.escrowed += amount;

  store.programs.set(programId, program);
  addTransaction(programId, "deposited", amount, `Deposited ${amount} wei to escrow`);
  addTransaction(programId, "escrowed", amount, `Added ${amount} wei to escrow balance`);

  return true;
}

export function allocateToTrial(programId: string, trialId: string, amountWei: string): boolean {
  const program = store.programs.get(programId);
  if (!program) return false;

  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  // Check available budget
  const available = program.budget.escrowed - program.budget.allocated;
  if (amount > available) {
    return false;
  }

  program.budget.allocated += amount;
  store.programs.set(programId, program);

  addTransaction(programId, "allocated", amount, `Allocated ${amount} wei to trial ${trialId}`);
  return true;
}

export function creditSettlement(programId: string, amountWei: string): boolean {
  const program = store.programs.get(programId);
  if (!program) return false;

  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  program.budget.pending += amount;
  program.budget.payable += amount;
  store.programs.set(programId, program);

  addTransaction(programId, "pending", amount, `Settlement pending: ${amount} wei`);
  addTransaction(programId, "payable", amount, `Credit payable: ${amount} wei`);

  return true;
}

export function recordPayment(programId: string, amountWei: string): boolean {
  const program = store.programs.get(programId);
  if (!program) return false;

  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  // Check payable balance
  if (amount > program.budget.payable) {
    return false;
  }

  program.budget.pending -= amount;
  program.budget.payable -= amount;
  program.budget.paid += amount;
  store.programs.set(programId, program);

  addTransaction(programId, "paid", amount, `Payment recorded: ${amount} wei`);
  return true;
}

export function recordWithdrawal(programId: string, amountWei: string): boolean {
  const program = store.programs.get(programId);
  if (!program) return false;

  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  // Check paid balance
  if (amount > program.budget.paid) {
    return false;
  }

  program.budget.paid -= amount;
  program.budget.withdrawn += amount;
  store.programs.set(programId, program);

  addTransaction(programId, "withdrawn", amount, `Withdrawal recorded: ${amount} wei`);
  return true;
}

/**
 * Get budget transactions for a program.
 */
export function getProgramTransactions(programId: string): BudgetTransaction[] {
  return store.transactions.get(programId) ?? [];
}

/**
 * Validate budget consistency. The three-truth model requires:
 * committed >= deposited >= escrowed >= allocated
 * pending <= payable <= paid + pending
 * paid >= withdrawn
 */
export function validateBudgetConsistency(programId: string): string[] {
  const program = store.programs.get(programId);
  if (!program) return ["Program not found"];

  const { committed, deposited, escrowed, allocated, pending, payable, paid, withdrawn } = program.budget;
  const errors: string[] = [];

  if (deposited > committed) {
    errors.push("Deposited exceeds committed budget");
  }
  if (escrowed > deposited) {
    errors.push("Escrowed exceeds deposited amount");
  }
  if (allocated > escrowed) {
    errors.push("Allocated exceeds escrowed amount");
  }
  if (payable > pending) {
    errors.push("Payable exceeds pending amount");
  }
  if (withdrawn > paid) {
    errors.push("Withdrawn exceeds paid amount");
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function resetSponsorStore(): void {
  store.sponsors.clear();
  store.programs.clear();
  store.transactions.clear();
}
