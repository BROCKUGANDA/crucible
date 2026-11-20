/**
 * @file sponsor-programme-pg.ts — the sponsor's own records, in PostgreSQL.
 *
 * The store behind `sponsor-onboarding.ts`. The domain rules (what a budget
 * may do, when a programme may launch, what consistency means) live in the
 * domain module; this file is the part that has to survive a restart, and it
 * is deliberately boring about it: SQL in, rows out.
 *
 * Three tables:
 *
 *   - `sponsor_orgs` — the customer record: name, wallet, contact, and the
 *     onboarding steps with the ones that are done.
 *   - `sponsor_programs` — the programme and its eight budget counters.
 *   - `budget_entries` — the budget's own ledger: every movement, appended
 *     and never overwritten.
 *
 * Every wei value is TEXT. Money never crosses a float — not in the
 * database, not on the way in, and not in the totals computed from these
 * rows.
 *
 * The budget counters are read and written inside a transaction with a row
 * lock, because two concurrent movements that both read "payable = 1 ETH" and
 * both write "payable = 0" is a bug that only appears under load, which is
 * the worst place for it to appear.
 */

import { getPool } from "@crucible/agent-security";
import type {
  BudgetState,
  BudgetTransaction,
  EligibilityConfig,
  EvaluationPeriod,
  ProgramBudget,
  ProgramStatus,
  RewardStructure,
  SponsorOrg,
  SponsorProgram,
} from "./sponsor-onboarding.js";

/** The domain's lowercase status words, and the table's uppercase ones. */
const PROGRAM_STATUS: Record<ProgramStatus, string> = {
  draft: "DRAFT",
  approved: "APPROVED",
  active: "ACTIVE",
  paused: "PAUSED",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
};

const PROGRAM_STATUS_BACK: Record<string, ProgramStatus> = {
  DRAFT: "draft",
  APPROVED: "approved",
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  SETTLED: "completed",
  FAILED: "cancelled",
};

const SPONSOR_STATUS: Record<SponsorOrg["status"], string> = {
  pending: "PENDING",
  approved: "APPROVED",
  active: "ACTIVE",
  suspended: "SUSPENDED",
  completed: "COMPLETED",
};

const SPONSOR_STATUS_BACK: Record<string, SponsorOrg["status"]> = {
  PENDING: "pending",
  APPROVED: "approved",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  COMPLETED: "completed",
};

function wei(value: bigint | string | null | undefined): string {
  if (value === null || value === undefined) return "0";
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * The reward structure, as JSON.
 *
 * The domain holds wei as `bigint`, and `JSON.stringify` throws on a bigint
 * rather than rounding it — so the wei leaves as strings and comes back as
 * bigints. Every other field of the structure is a plain number or a list.
 */
function rewardToJson(reward: RewardStructure): string {
  return JSON.stringify({
    rewardPerTrial: wei(reward.rewardPerTrial),
    topPerformerBonus: reward.topPerformerBonus === undefined ? null : wei(reward.topPerformerBonus),
    safetyPenalty: reward.safetyPenalty === undefined ? null : wei(reward.safetyPenalty),
  });
}

/** The reward structure, from JSON, with the wei back as bigints. */
function rewardFromJson(raw: unknown): RewardStructure {
  const source = (raw ?? {}) as Record<string, unknown>;
  const bonus = source.topPerformerBonus;
  const penalty = source.safetyPenalty;
  return {
    rewardPerTrial: BigInt((source.rewardPerTrial as string) ?? "0"),
    topPerformerBonus: bonus === null || bonus === undefined ? undefined : BigInt(bonus as string),
    safetyPenalty: penalty === null || penalty === undefined ? undefined : BigInt(penalty as string),
  };
}

function rowToSponsor(row: Record<string, unknown>): SponsorOrg {
  const steps = Array.isArray(row.onboarding_steps) ? row.onboarding_steps : [];
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? "",
    name: row.name as string,
    walletAddress: (row.wallet_address as string) ?? "",
    contactEmail: (row.contact_email as string) ?? "",
    status: SPONSOR_STATUS_BACK[(row.status as string) ?? "PENDING"] ?? "pending",
    onboardingSteps: steps as SponsorOrg["onboardingSteps"],
    createdAt: Number(row.created_at),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? undefined : Number(row.approved_at),
  };
}

function rowToProgram(row: Record<string, unknown>): SponsorProgram {
  const eligibility = (row.eligibility ?? {}) as EligibilityConfig;
  const rewardStructure = rewardFromJson(row.reward_structure);
  const evaluationPeriod = (row.evaluation_period ?? { start: 0, end: 0 }) as EvaluationPeriod;
  const budget: ProgramBudget = {
    committed: BigInt((row.committed_wei as string) ?? "0"),
    deposited: BigInt((row.deposited_wei as string) ?? "0"),
    escrowed: BigInt((row.escrowed_wei as string) ?? "0"),
    allocated: BigInt((row.allocated_wei as string) ?? "0"),
    pending: BigInt((row.pending_wei as string) ?? "0"),
    payable: BigInt((row.payable_wei as string) ?? "0"),
    paid: BigInt((row.paid_wei as string) ?? "0"),
    withdrawn: BigInt((row.withdrawn_wei as string) ?? "0"),
  };
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? "",
    sponsorId: (row.sponsor_id as string) ?? "",
    name: row.name as string,
    description: (row.description as string) ?? "",
    objectives: (row.objectives as string) ?? "",
    status: PROGRAM_STATUS_BACK[(row.status as string) ?? "DRAFT"] ?? "draft",
    budget,
    eligibility,
    rewardStructure,
    suites: Array.isArray(row.suites) ? (row.suites as string[]) : [],
    evaluationPeriod,
    disputeRules: (row.dispute_rules as string) ?? "",
    publicationPolicy: ((row.publication_policy as string) ?? "public") as SponsorProgram["publicationPolicy"],
    createdAt: Number(row.created_at),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? undefined : Number(row.approved_at),
    launchedAt: row.launched_at === null || row.launched_at === undefined ? undefined : Number(row.launched_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? undefined : Number(row.completed_at),
  };
}

function rowToEntry(row: Record<string, unknown>): BudgetTransaction {
  return {
    id: row.id as string,
    programId: row.program_id as string,
    state: (row.type as BudgetState) ?? "committed",
    amount: BigInt((row.amount_wei as string) ?? "0"),
    description: (row.description as string) ?? "",
    createdAt: Number(row.created_at),
  };
}

/** The budget counters, in the order the UPDATE statement names them. */
const BUDGET_COLUMNS = [
  "committed_wei",
  "deposited_wei",
  "escrowed_wei",
  "allocated_wei",
  "pending_wei",
  "payable_wei",
  "paid_wei",
  "withdrawn_wei",
] as const;

function budgetValues(budget: ProgramBudget): string[] {
  return [
    wei(budget.committed),
    wei(budget.deposited),
    wei(budget.escrowed),
    wei(budget.allocated),
    wei(budget.pending),
    wei(budget.payable),
    wei(budget.paid),
    wei(budget.withdrawn),
  ];
}

/**
 * Read a programme FOR UPDATE and hand it to a mutator, inside one
 * transaction.
 *
 * The mutator returns the new budget and the ledger entries the movement
 * produced. If it returns null, nothing is written — that is how a refused
 * movement ("not enough payable") leaves no trace.
 */
async function mutateProgram(
  programId: string,
  mutate: (program: SponsorProgram) => { budget: ProgramBudget; entries: BudgetTransaction[] } | null,
): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT * FROM sponsor_programs WHERE id = $1 FOR UPDATE",
      [programId],
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    const program = rowToProgram(row);
    const outcome = mutate(program);
    if (!outcome) {
      await client.query("ROLLBACK");
      return false;
    }
    const values = budgetValues(outcome.budget);
    const assignments = BUDGET_COLUMNS.map((column, index) => `${column} = $${index + 2}`).join(", ");
    await client.query(
      `UPDATE sponsor_programs SET ${assignments}, updated_at = $${BUDGET_COLUMNS.length + 2} WHERE id = $1`,
      [programId, ...values, Date.now()],
    );
    for (const entry of outcome.entries) {
      await client.query(
        `INSERT INTO budget_entries (id, program_id, type, amount_wei, description, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entry.id, entry.programId, entry.state, wei(entry.amount), entry.description, entry.createdAt],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; the transaction is gone either way.
    }
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

/**
 * The durable store.
 *
 * It satisfies the same interface the in-memory store does, so the domain
 * module does not know which one it is talking to.
 */
export const pgSponsorStore = {
  async putSponsor(sponsor: SponsorOrg): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO sponsor_orgs
         (id, org_id, name, wallet_address, contact_email, status, onboarding_steps, created_at, approved_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         name = EXCLUDED.name,
         wallet_address = EXCLUDED.wallet_address,
         contact_email = EXCLUDED.contact_email,
         status = EXCLUDED.status,
         onboarding_steps = EXCLUDED.onboarding_steps,
         approved_at = EXCLUDED.approved_at,
         updated_at = EXCLUDED.updated_at`,
      [
        sponsor.id,
        sponsor.orgId,
        sponsor.name,
        sponsor.walletAddress,
        sponsor.contactEmail,
        SPONSOR_STATUS[sponsor.status] ?? "PENDING",
        JSON.stringify(sponsor.onboardingSteps),
        sponsor.createdAt,
        sponsor.approvedAt ?? null,
        Date.now(),
      ],
    );
  },

  async getSponsor(id: string): Promise<SponsorOrg | undefined> {
    const pool = getPool();
    const r = await pool.query("SELECT * FROM sponsor_orgs WHERE id = $1", [id]);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    return row ? rowToSponsor(row) : undefined;
  },

  async listSponsors(filter: { status?: SponsorOrg["status"]; orgId?: string } = {}): Promise<SponsorOrg[]> {
    const pool = getPool();
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.status) {
      values.push(SPONSOR_STATUS[filter.status]);
      clauses.push(`status = $${values.length}`);
    }
    if (filter.orgId) {
      values.push(filter.orgId);
      clauses.push(`org_id = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await pool.query(`SELECT * FROM sponsor_orgs ${where} ORDER BY created_at ASC`, values);
    return r.rows.map((row: Record<string, unknown>) => rowToSponsor(row));
  },

  async putProgram(program: SponsorProgram): Promise<void> {
    const pool = getPool();
    const values = budgetValues(program.budget);
    await pool.query(
      `INSERT INTO sponsor_programs
         (id, org_id, sponsor_id, name, description, objectives, status,
          budget_cap_wei, committed_wei, deposited_wei, escrowed_wei, allocated_wei,
          pending_wei, payable_wei, paid_wei, withdrawn_wei,
          eligibility, reward_structure, suites, evaluation_period,
          publication_policy, dispute_rules, created_at, approved_at, launched_at, completed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb,
               $21, $22, $23, $24, $25, $26, $27)
       ON CONFLICT (id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         sponsor_id = EXCLUDED.sponsor_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         objectives = EXCLUDED.objectives,
         status = EXCLUDED.status,
         committed_wei = EXCLUDED.committed_wei,
         deposited_wei = EXCLUDED.deposited_wei,
         escrowed_wei = EXCLUDED.escrowed_wei,
         allocated_wei = EXCLUDED.allocated_wei,
         pending_wei = EXCLUDED.pending_wei,
         payable_wei = EXCLUDED.payable_wei,
         paid_wei = EXCLUDED.paid_wei,
         withdrawn_wei = EXCLUDED.withdrawn_wei,
         eligibility = EXCLUDED.eligibility,
         reward_structure = EXCLUDED.reward_structure,
         suites = EXCLUDED.suites,
         evaluation_period = EXCLUDED.evaluation_period,
         publication_policy = EXCLUDED.publication_policy,
         dispute_rules = EXCLUDED.dispute_rules,
         approved_at = EXCLUDED.approved_at,
         launched_at = EXCLUDED.launched_at,
         completed_at = EXCLUDED.completed_at,
         updated_at = EXCLUDED.updated_at`,
      [
        program.id,
        program.orgId,
        program.sponsorId,
        program.name,
        program.description,
        program.objectives,
        PROGRAM_STATUS[program.status] ?? "DRAFT",
        // The cap and the eight counters are the same number today: the
        // committed budget IS the cap. They are separate columns because
        // they are separate facts — a cap that can be raised is not a cap.
        wei(program.budget.committed),
        ...values,
        JSON.stringify(program.eligibility),
        rewardToJson(program.rewardStructure),
        JSON.stringify(program.suites),
        JSON.stringify(program.evaluationPeriod),
        program.publicationPolicy,
        program.disputeRules,
        program.createdAt,
        program.approvedAt ?? null,
        program.launchedAt ?? null,
        program.completedAt ?? null,
        Date.now(),
      ],
    );
  },

  async getProgram(id: string): Promise<SponsorProgram | undefined> {
    const pool = getPool();
    const r = await pool.query("SELECT * FROM sponsor_programs WHERE id = $1", [id]);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    return row ? rowToProgram(row) : undefined;
  },

  async listPrograms(
    filter: { sponsorId?: string; status?: ProgramStatus; orgId?: string } = {},
  ): Promise<SponsorProgram[]> {
    const pool = getPool();
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.sponsorId) {
      values.push(filter.sponsorId);
      clauses.push(`sponsor_id = $${values.length}`);
    }
    if (filter.status) {
      values.push(PROGRAM_STATUS[filter.status]);
      clauses.push(`status = $${values.length}`);
    }
    if (filter.orgId) {
      values.push(filter.orgId);
      clauses.push(`org_id = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await pool.query(`SELECT * FROM sponsor_programs ${where} ORDER BY created_at ASC`, values);
    return r.rows.map((row: Record<string, unknown>) => rowToProgram(row));
  },

  async appendBudgetEntry(entry: BudgetTransaction): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO budget_entries (id, program_id, type, amount_wei, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.id, entry.programId, entry.state, wei(entry.amount), entry.description, entry.createdAt],
    );
  },

  async listBudgetEntries(programId: string): Promise<BudgetTransaction[]> {
    const pool = getPool();
    // The insertion order is the ledger's order: `seq`, not `created_at`.
    // Two entries written in the same millisecond have the same timestamp,
    // and a random id as a tie-break produces a different order every run.
    const r = await pool.query(
      "SELECT * FROM budget_entries WHERE program_id = $1 ORDER BY seq ASC",
      [programId],
    );
    return r.rows.map((row: Record<string, unknown>) => rowToEntry(row));
  },

  /**
   * Move the budget, atomically.
   *
   * The mutator is given the programme as it is right now, under a row lock,
   * and returns the new budget and the entries the movement produced. It
   * returns null when the movement is refused, and a refusal writes nothing.
   */
  async moveBudget(
    programId: string,
    mutate: (program: SponsorProgram) => { budget: ProgramBudget; entries: BudgetTransaction[] } | null,
  ): Promise<boolean> {
    return mutateProgram(programId, mutate);
  },
};
