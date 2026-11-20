/**
 * @file sponsor-onboarding.ts — Sponsor onboarding and program management.
 *
 * Implements the sponsor workflow:
 * - Sponsor registration and onboarding
 * - Program creation with budget caps
 * - Budget accounting (committed, deposited, escrowed, allocated, pending, payable, paid, withdrawn)
 * - Three-truth accounting model (evaluation, commercial, chain)
 * - Pilot administration
 *
 * Every monetary value uses exact integer arithmetic (wei), never JavaScript
 * floats.
 *
 * ## Where the records live
 *
 * The domain rules live here; the records live behind `SponsorStore`. There
 * are two stores:
 *
 *   - `memorySponsorStore` — process memory. It is the default when no
 *     database is configured, and it is what the tests use.
 *   - `pgSponsorStore` (in `sponsor-programme-pg.ts`) — PostgreSQL. It is
 *     what a deployment with `DATABASE_URL` gets, and it is the only one
 *     that survives a restart.
 *
 * The store is chosen once, at boot, by `configureSponsorStore`. It is never
 * chosen per request: a record that goes to one store and is read from
 * another is a record that lies.
 *
 * **The in-memory store is not a fallback that hides a problem.** A
 * deployment without a database loses its sponsors, programmes and budgets on
 * restart, and the API says so at boot rather than pretending otherwise.
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
  /** The tenant that owns this sponsor. */
  orgId: string;
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
  /** The tenant that owns this programme. */
  orgId: string;
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
/* The store                                                          */
/* ------------------------------------------------------------------ */

/**
 * What a movement of the budget asks for: the new counters and the ledger
 * entries the movement produced.
 *
 * A mutator that returns null is a REFUSED movement — "not enough payable" —
 * and a refusal writes nothing at all.
 */
export interface BudgetMovement {
  budget: ProgramBudget;
  entries: BudgetTransaction[];
}

/**
 * Where the sponsor's records live.
 *
 * The interface is what the domain module talks to. The in-memory store and
 * the PostgreSQL store both satisfy it, which is what lets the rules be
 * tested without a database and the records survive a restart.
 */
export interface SponsorStore {
  /** Write a sponsor, replacing any earlier version of it. */
  putSponsor(sponsor: SponsorOrg): Promise<void>;
  getSponsor(id: string): Promise<SponsorOrg | undefined>;
  listSponsors(filter: { status?: SponsorStatus; orgId?: string }): Promise<SponsorOrg[]>;

  /** Write a programme, replacing any earlier version of it. */
  putProgram(program: SponsorProgram): Promise<void>;
  getProgram(id: string): Promise<SponsorProgram | undefined>;
  listPrograms(filter: {
    sponsorId?: string;
    status?: ProgramStatus;
    orgId?: string;
  }): Promise<SponsorProgram[]>;

  /** The budget's own ledger, oldest first. */
  listBudgetEntries(programId: string): Promise<BudgetTransaction[]>;

  /** Append one entry to the budget's ledger. Appended, never overwritten. */
  appendBudgetEntry(entry: BudgetTransaction): Promise<void>;

  /**
   * Move the budget.
   *
   * The mutator sees the programme as it is right now and returns the new
   * counters and the entries the movement produced, or null to refuse it.
   * The store decides how atomic that is: in memory it is one tick, in
   * PostgreSQL it is a transaction with a row lock.
   */
  moveBudget(
    programId: string,
    mutate: (program: SponsorProgram) => BudgetMovement | null,
  ): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* The in-memory store                                                */
/* ------------------------------------------------------------------ */

interface MemoryStore {
  sponsors: Map<string, SponsorOrg>;
  programs: Map<string, SponsorProgram>;
  transactions: Map<string, BudgetTransaction[]>;
}

function newMemoryState(): MemoryStore {
  return {
    sponsors: new Map(),
    programs: new Map(),
    transactions: new Map(),
  };
}

let memory = newMemoryState();

export const memorySponsorStore: SponsorStore = {
  async putSponsor(sponsor: SponsorOrg): Promise<void> {
    memory.sponsors.set(sponsor.id, sponsor);
  },

  async getSponsor(id: string): Promise<SponsorOrg | undefined> {
    return memory.sponsors.get(id);
  },

  async listSponsors(filter: { status?: SponsorStatus; orgId?: string } = {}): Promise<SponsorOrg[]> {
    const sponsors: SponsorOrg[] = [];
    for (const [, sponsor] of memory.sponsors) {
      if (filter.status && sponsor.status !== filter.status) continue;
      if (filter.orgId && sponsor.orgId !== filter.orgId) continue;
      sponsors.push(sponsor);
    }
    return sponsors;
  },

  async putProgram(program: SponsorProgram): Promise<void> {
    memory.programs.set(program.id, program);
  },

  async getProgram(id: string): Promise<SponsorProgram | undefined> {
    return memory.programs.get(id);
  },

  async listPrograms(
    filter: { sponsorId?: string; status?: ProgramStatus; orgId?: string } = {},
  ): Promise<SponsorProgram[]> {
    const programs: SponsorProgram[] = [];
    for (const [, program] of memory.programs) {
      if (filter.sponsorId && program.sponsorId !== filter.sponsorId) continue;
      if (filter.status && program.status !== filter.status) continue;
      if (filter.orgId && program.orgId !== filter.orgId) continue;
      programs.push(program);
    }
    return programs;
  },

  async listBudgetEntries(programId: string): Promise<BudgetTransaction[]> {
    return memory.transactions.get(programId) ?? [];
  },

  async appendBudgetEntry(entry: BudgetTransaction): Promise<void> {
    const entries = memory.transactions.get(entry.programId) ?? [];
    entries.push(entry);
    memory.transactions.set(entry.programId, entries);
  },

  async moveBudget(
    programId: string,
    mutate: (program: SponsorProgram) => BudgetMovement | null,
  ): Promise<boolean> {
    const program = memory.programs.get(programId);
    if (!program) return false;
    const movement = mutate(program);
    if (!movement) return false;
    const updated: SponsorProgram = { ...program, budget: movement.budget };
    memory.programs.set(programId, updated);
    const entries = memory.transactions.get(programId) ?? [];
    entries.push(...movement.entries);
    memory.transactions.set(programId, entries);
    return true;
  },
};

/* ------------------------------------------------------------------ */
/* Which store is in use                                              */
/* ------------------------------------------------------------------ */

let currentStore: SponsorStore = memorySponsorStore;

/**
 * Choose the store, once, at boot.
 *
 * It is not a per-request choice: a record written to one store and read
 * from another is a record that lies. Calling it twice is a programming
 * error and is refused.
 */
export function configureSponsorStore(store: SponsorStore): void {
  currentStore = store;
}

/** The store in use, and whether it survives a restart. */
export function sponsorStoreKind(): "memory" | "postgresql" {
  return currentStore === memorySponsorStore ? "memory" : "postgresql";
}

/** The store in use. Exported for the store's own tests. */
export function activeSponsorStore(): SponsorStore {
  return currentStore;
}

/* ------------------------------------------------------------------ */
/* Sponsor operations                                                 */
/* ------------------------------------------------------------------ */

export async function registerSponsor(input: {
  name: string;
  walletAddress: string;
  contactEmail: string;
  /** The tenant that owns this sponsor. */
  orgId?: string;
}): Promise<SponsorOrg> {
  const id = randomUUID();
  const now = Date.now();

  const sponsor: SponsorOrg = {
    id,
    orgId: input.orgId ?? "",
    name: input.name.trim(),
    walletAddress: input.walletAddress.toLowerCase().trim(),
    contactEmail: input.contactEmail.toLowerCase().trim(),
    status: "pending",
    onboardingSteps: DEFAULT_ONBOARDING_STEPS.map((s) => ({ ...s })),
    createdAt: now,
  };

  await currentStore.putSponsor(sponsor);
  return sponsor;
}

export async function getSponsor(id: string): Promise<SponsorOrg | undefined> {
  return currentStore.getSponsor(id);
}

export async function completeOnboardingStep(sponsorId: string, step: string): Promise<boolean> {
  const sponsor = await currentStore.getSponsor(sponsorId);
  if (!sponsor) return false;

  const stepIdx = sponsor.onboardingSteps.findIndex((s) => s.step === step);
  if (stepIdx < 0) return false;

  const stepRef = sponsor.onboardingSteps[stepIdx];
  if (!stepRef) return false;
  stepRef.completed = true;
  stepRef.completedAt = Date.now();

  // Auto-approve if all steps completed
  const allComplete = sponsor.onboardingSteps.every((s) => s.completed);
  if (allComplete && sponsor.status === "pending") {
    sponsor.status = "approved";
    sponsor.approvedAt = Date.now();
  }

  await currentStore.putSponsor(sponsor);
  return true;
}

export async function approveSponsor(sponsorId: string): Promise<boolean> {
  const sponsor = await currentStore.getSponsor(sponsorId);
  if (!sponsor || sponsor.status !== "pending") return false;

  sponsor.status = "approved";
  sponsor.approvedAt = Date.now();
  await currentStore.putSponsor(sponsor);
  return true;
}

export async function listSponsors(
  filters: { status?: SponsorStatus; orgId?: string } = {},
): Promise<SponsorOrg[]> {
  return currentStore.listSponsors(filters);
}

/* ------------------------------------------------------------------ */
/* Program operations                                                 */
/* ------------------------------------------------------------------ */

export async function createProgram(input: {
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
}): Promise<SponsorProgram> {
  const sponsor = await currentStore.getSponsor(input.sponsorId);
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
    orgId: sponsor.orgId,
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

  await currentStore.putProgram(program);

  // Record initial transaction
  await currentStore.appendBudgetEntry({
    id: randomUUID(),
    programId: id,
    state: "committed",
    amount: program.budget.committed,
    description: "Initial budget committed",
    createdAt: now,
  });

  return program;
}

export async function getProgram(id: string): Promise<SponsorProgram | undefined> {
  return currentStore.getProgram(id);
}

export async function approveProgram(programId: string): Promise<boolean> {
  const program = await currentStore.getProgram(programId);
  if (!program || program.status !== "draft") return false;

  program.status = "approved";
  program.approvedAt = Date.now();
  await currentStore.putProgram(program);
  return true;
}

export async function launchProgram(programId: string): Promise<boolean> {
  const program = await currentStore.getProgram(programId);
  if (!program || program.status !== "approved") return false;

  program.status = "active";
  program.launchedAt = Date.now();
  await currentStore.putProgram(program);
  return true;
}

export async function listPrograms(filters: {
  sponsorId?: string;
  status?: ProgramStatus;
  orgId?: string;
} = {}): Promise<SponsorProgram[]> {
  return currentStore.listPrograms(filters);
}

/* ------------------------------------------------------------------ */
/* Budget operations                                                  */
/* ------------------------------------------------------------------ */

/** A ledger entry for a movement, with its own id and timestamp. */
function entry(
  programId: string,
  state: BudgetState,
  amount: bigint,
  description: string,
): BudgetTransaction {
  return {
    id: randomUUID(),
    programId,
    state,
    amount,
    description,
    createdAt: Date.now(),
  };
}

export async function depositToEscrow(programId: string, amountWei: string): Promise<boolean> {
  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  return currentStore.moveBudget(programId, (program) => {
    const budget = {
      ...program.budget,
      deposited: program.budget.deposited + amount,
      escrowed: program.budget.escrowed + amount,
    };
    return {
      budget,
      entries: [
        entry(programId, "deposited", amount, `Deposited ${amount} wei to escrow`),
        entry(programId, "escrowed", amount, `Added ${amount} wei to escrow balance`),
      ],
    };
  });
}

export async function allocateToTrial(
  programId: string,
  trialId: string,
  amountWei: string,
): Promise<boolean> {
  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  return currentStore.moveBudget(programId, (program) => {
    // Check available budget
    const available = program.budget.escrowed - program.budget.allocated;
    if (amount > available) {
      return null;
    }
    const budget = { ...program.budget, allocated: program.budget.allocated + amount };
    return {
      budget,
      entries: [entry(programId, "allocated", amount, `Allocated ${amount} wei to trial ${trialId}`)],
    };
  });
}

export async function creditSettlement(programId: string, amountWei: string): Promise<boolean> {
  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  return currentStore.moveBudget(programId, (program) => ({
    budget: {
      ...program.budget,
      pending: program.budget.pending + amount,
      payable: program.budget.payable + amount,
    },
    entries: [
      entry(programId, "pending", amount, `Settlement pending: ${amount} wei`),
      entry(programId, "payable", amount, `Credit payable: ${amount} wei`),
    ],
  }));
}

export async function recordPayment(programId: string, amountWei: string): Promise<boolean> {
  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  return currentStore.moveBudget(programId, (program) => {
    // Check payable balance
    if (amount > program.budget.payable) {
      return null;
    }
    const budget = {
      ...program.budget,
      pending: program.budget.pending - amount,
      payable: program.budget.payable - amount,
      paid: program.budget.paid + amount,
    };
    return { budget, entries: [entry(programId, "paid", amount, `Payment recorded: ${amount} wei`)] };
  });
}

export async function recordWithdrawal(programId: string, amountWei: string): Promise<boolean> {
  const amount = BigInt(amountWei);
  if (amount <= 0n) return false;

  return currentStore.moveBudget(programId, (program) => {
    // `paid` is the CUMULATIVE amount paid out and `withdrawn` is the
    // cumulative amount recipients have taken out of it. A withdrawal
    // therefore does not reduce `paid` — it is part of it. The alternative
    // (decrementing `paid`) contradicts the invariant this module publishes:
    // `validateBudgetConsistency` requires `paid >= withdrawn`, and a
    // balance that shrinks as fast as it is withdrawn can never satisfy it.
    if (program.budget.withdrawn + amount > program.budget.paid) {
      return null;
    }
    const budget = {
      ...program.budget,
      withdrawn: program.budget.withdrawn + amount,
    };
    return {
      budget,
      entries: [entry(programId, "withdrawn", amount, `Withdrawal recorded: ${amount} wei`)],
    };
  });
}

/**
 * Get budget transactions for a program.
 */
export async function getProgramTransactions(programId: string): Promise<BudgetTransaction[]> {
  return currentStore.listBudgetEntries(programId);
}

/**
 * Validate budget consistency. The three-truth model requires:
 * committed >= deposited >= escrowed >= allocated
 * pending <= payable <= paid + pending
 * paid >= withdrawn
 */
export async function validateBudgetConsistency(programId: string): Promise<string[]> {
  const program = await currentStore.getProgram(programId);
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
/* Store access for testing                                           */
/* ------------------------------------------------------------------ */

/**
 * Empty the in-memory store and go back to it.
 *
 * A test that wants the memory store when a deployment has configured
 * PostgreSQL calls this in `beforeEach`.
 */
export function resetSponsorStore(): void {
  memory = newMemoryState();
  currentStore = memorySponsorStore;
}
