/**
 * @file sponsor-programme-pg.test.ts — the sponsor's records, in PostgreSQL.
 *
 * The claim under test: the sponsor's programmes, budgets and ledger survive
 * a restart, and the durable store says the same things the in-memory store
 * says.
 *
 * The store is exercised against a REAL PostgreSQL, not a fake pool: a fake
 * cannot tell you that a column does not exist, that a foreign key refuses
 * a legitimate write, or that two counters update together. Those are
 * exactly the failures this file exists to catch.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly — the same rule the Redis-backed cases follow.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "@crucible/agent-security";
import {
  configureSponsorStore,
  resetSponsorStore,
  registerSponsor,
  getSponsor,
  listSponsors,
  completeOnboardingStep,
  approveSponsor,
  createProgram,
  getProgram,
  listPrograms,
  approveProgram,
  launchProgram,
  depositToEscrow,
  allocateToTrial,
  creditSettlement,
  recordPayment,
  recordWithdrawal,
  getProgramTransactions,
  validateBudgetConsistency,
  sponsorStoreKind,
} from "../src/sponsor-onboarding.js";
import { pgSponsorStore } from "../src/sponsor-programme-pg.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

suite("sponsor-programme-pg", () => {
  beforeAll(async () => {
    await runMigrations();
    configureSponsorStore(pgSponsorStore);
  });

  afterAll(async () => {
    resetSponsorStore();
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM budget_entries");
    await getPool().query("DELETE FROM sponsor_programs");
    await getPool().query("DELETE FROM sponsor_orgs");
  });

  it("says that the ledger is durable", () => {
    expect(sponsorStoreKind()).toBe("postgresql");
  });

  it("keeps a sponsor across a fresh read", async () => {
    const created = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });

    // Read it back the way another process would: not from the object that
    // was just built, but from the database.
    const found = await getSponsor(created.id);
    expect(found).not.toBeUndefined();
    expect(found?.name).toBe("Durable Sponsor");
    // The wallet is lower-cased on write, so the comparison is exact.
    expect(found?.walletAddress).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(found?.status).toBe("pending");
    expect(found?.onboardingSteps.length).toBeGreaterThan(0);
  });

  it("keeps a programme and its budget", async () => {
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x1",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });
    await approveSponsor(sponsor.id);

    const program = await createProgram({
      sponsorId: sponsor.id,
      name: "Durable Program",
      description: "A programme that must outlive the process",
      objectives: "Measure agents",
      budgetWei: "1000000000000000000",
      rewardPerTrialWei: "100000000000000000",
      suites: ["suite-1"],
      evaluationPeriod: { start: 1, end: 2 },
    });

    const found = await getProgram(program.id);
    expect(found).not.toBeUndefined();
    expect(found?.name).toBe("Durable Program");
    expect(found?.suites).toEqual(["suite-1"]);
    expect(found?.budget.committed).toBe(1_000_000_000_000_000_000n);
    // The programme belongs to the sponsor's tenant.
    expect(found?.orgId).toBe("org_durable");
    expect(found?.sponsorId).toBe(sponsor.id);
  });

  it("moves the budget and writes the movement to the ledger", async () => {
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x2",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });
    await approveSponsor(sponsor.id);
    const program = await createProgram({
      sponsorId: sponsor.id,
      name: "Durable Program",
      description: "d",
      objectives: "o",
      budgetWei: "1000000000000000000",
      rewardPerTrialWei: "100000000000000000",
      suites: [],
      evaluationPeriod: { start: 1, end: 2 },
    });

    expect(await depositToEscrow(program.id, "500000000000000000")).toBe(true);

    const after = await getProgram(program.id);
    expect(after?.budget.deposited).toBe(500_000_000_000_000_000n);
    expect(after?.budget.escrowed).toBe(500_000_000_000_000_000n);
    expect(after?.budget.committed).toBe(1_000_000_000_000_000_000n);

    // Every movement is in the ledger, and the ledger was written to the
    // database, not to a Map.
    const entries = await getProgramTransactions(program.id);
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.state)).toEqual(["committed", "deposited", "escrowed"]);
    expect(entries[1]?.amount).toBe(500_000_000_000_000_000n);

    const rows = await getPool().query(
      "SELECT type, amount_wei FROM budget_entries WHERE program_id = $1 ORDER BY created_at ASC",
      [program.id],
    );
    expect(rows.rows.length).toBe(3);
    expect(rows.rows[1]?.amount_wei).toBe("500000000000000000");
  });

  it("refuses a second withdrawal that would exceed what was paid", async () => {
    // Paid is cumulative, so two withdrawals add up: 60 + 60 is 120 against
    // a paid total of 100, and the second one must be refused. A check that
    // only looks at the amount being withdrawn (60 against 100) would let
    // the programme pay out more than it paid.
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x9",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });
    await approveSponsor(sponsor.id);
    const program = await createProgram({
      sponsorId: sponsor.id,
      name: "Durable Program",
      description: "d",
      objectives: "o",
      budgetWei: "1000000000000000000",
      rewardPerTrialWei: "100000000000000000",
      suites: [],
      evaluationPeriod: { start: 1, end: 2 },
    });

    await creditSettlement(program.id, "100000000000000000");
    await recordPayment(program.id, "100000000000000000");

    expect(await recordWithdrawal(program.id, "60000000000000000")).toBe(true);
    expect(await recordWithdrawal(program.id, "60000000000000000")).toBe(false);

    const after = await getProgram(program.id);
    expect(after?.budget.withdrawn).toBe(60_000_000_000_000_000n);
    expect(after?.budget.paid).toBe(100_000_000_000_000_000n);
  });

  it("reads the ledger in insertion order, not in timestamp order", async () => {
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x10",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });
    await approveSponsor(sponsor.id);
    const program = await createProgram({
      sponsorId: sponsor.id,
      name: "Durable Program",
      description: "d",
      objectives: "o",
      budgetWei: "1000000000000000000",
      rewardPerTrialWei: "100000000000000000",
      suites: [],
      evaluationPeriod: { start: 1, end: 2 },
    });

    // A row written LAST but stamped EARLIER. The ledger is read by
    // insertion order, so it comes last in the reading — a ledger read by
    // timestamp would put it first, and two movements written in the same
    // millisecond would come out in an arbitrary order.
    await getPool().query(
      `INSERT INTO budget_entries (id, program_id, type, amount_wei, description, created_at)
       VALUES ('entry_written_last_stamped_early', $1, 'committed', '1', 'stamped earlier', 1)`,
      [program.id],
    );

    const entries = await getProgramTransactions(program.id);
    expect(entries.length).toBe(2);
    expect(entries[0]?.state).toBe("committed");
    expect(entries[0]?.description).toBe("Initial budget committed");
    expect(entries[1]?.description).toBe("stamped earlier");
  });

  it("refuses a movement the budget cannot cover, and writes nothing", async () => {
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x3",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });
    await approveSponsor(sponsor.id);
    const program = await createProgram({
      sponsorId: sponsor.id,
      name: "Durable Program",
      description: "d",
      objectives: "o",
      budgetWei: "1000000000000000000",
      rewardPerTrialWei: "100000000000000000",
      suites: [],
      evaluationPeriod: { start: 1, end: 2 },
    });

    // Nothing is in escrow, so nothing can be allocated.
    expect(await allocateToTrial(program.id, "1", "100000000000000000")).toBe(false);
    // And nothing was paid, so nothing can be withdrawn.
    expect(await recordWithdrawal(program.id, "1")).toBe(false);

    const after = await getProgram(program.id);
    expect(after?.budget.allocated).toBe(0n);
    expect(after?.budget.withdrawn).toBe(0n);

    // A refusal writes no ledger entry: the budget's own history is a record
    // of what happened, not of what was attempted.
    const entries = await getProgramTransactions(program.id);
    expect(entries.length).toBe(1);
    expect(entries[0]?.state).toBe("committed");
  });

  it("carries the whole budget lifecycle", async () => {
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x4",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });
    await approveSponsor(sponsor.id);
    const program = await createProgram({
      sponsorId: sponsor.id,
      name: "Durable Program",
      description: "d",
      objectives: "o",
      budgetWei: "1000000000000000000",
      rewardPerTrialWei: "100000000000000000",
      suites: [],
      evaluationPeriod: { start: 1, end: 2 },
    });

    await depositToEscrow(program.id, "800000000000000000");
    await allocateToTrial(program.id, "1", "300000000000000000");
    await creditSettlement(program.id, "300000000000000000");
    await recordPayment(program.id, "300000000000000000");
    await recordWithdrawal(program.id, "300000000000000000");

    const after = await getProgram(program.id);
    expect(after?.budget.allocated).toBe(300_000_000_000_000_000n);
    // `paid` is cumulative and `withdrawn` is cumulative: paying 300 and
    // withdrawing 300 leaves 300 paid and 300 withdrawn — which is what
    // makes the published invariant `paid >= withdrawn` hold.
    expect(after?.budget.paid).toBe(300_000_000_000_000_000n);
    expect(after?.budget.withdrawn).toBe(300_000_000_000_000_000n);
    expect(await validateBudgetConsistency(program.id)).toEqual([]);
  });

  it("lists sponsors and programmes by their tenant", async () => {
    await registerSponsor({
      name: "One",
      walletAddress: "0x5",
      contactEmail: "one@example.com",
      orgId: "org_one",
    });
    await registerSponsor({
      name: "Two",
      walletAddress: "0x6",
      contactEmail: "two@example.com",
      orgId: "org_two",
    });

    const oneOnly = await listSponsors({ orgId: "org_one" });
    expect(oneOnly.length).toBe(1);
    expect(oneOnly[0]?.name).toBe("One");
    expect((await listSponsors({})).length).toBe(2);
  });

  it("records the onboarding steps and the approval", async () => {
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x7",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });

    expect(await completeOnboardingStep(sponsor.id, "organization")).toBe(true);
    const found = await getSponsor(sponsor.id);
    expect(found?.onboardingSteps[0]?.completed).toBe(true);
    expect(found?.status).toBe("pending");

    expect(await approveSponsor(sponsor.id)).toBe(true);
    expect((await getSponsor(sponsor.id))?.status).toBe("approved");
  });

  it("moves a programme through draft, approved and active", async () => {
    const sponsor = await registerSponsor({
      name: "Durable Sponsor",
      walletAddress: "0x8",
      contactEmail: "sponsor@example.com",
      orgId: "org_durable",
    });
    await approveSponsor(sponsor.id);
    const program = await createProgram({
      sponsorId: sponsor.id,
      name: "Durable Program",
      description: "d",
      objectives: "o",
      budgetWei: "1000000000000000000",
      rewardPerTrialWei: "100000000000000000",
      suites: [],
      evaluationPeriod: { start: 1, end: 2 },
    });

    expect((await getProgram(program.id))?.status).toBe("draft");
    expect(await approveProgram(program.id)).toBe(true);
    expect((await getProgram(program.id))?.status).toBe("approved");
    expect(await launchProgram(program.id)).toBe(true);
    const launched = await getProgram(program.id);
    expect(launched?.status).toBe("active");
    expect(launched?.launchedAt).toBeGreaterThan(0);
    expect((await listPrograms({ sponsorId: sponsor.id })).length).toBe(1);
  });

  it("writes a funding claim for a programme whose tenant has no organisation row", async () => {
    // The organisation model is in process memory, so the `organisations`
    // table is empty in every real deployment. A claim must still be
    // storable: this is the write that failed with a foreign key violation
    // before migration 0012.
    const { pgRecordFundingClaim } = await import("../src/sponsor-funding-pg.js");
    const claim = await pgRecordFundingClaim({
      programId: "prog_never_migrated",
      orgId: "org_that_does_not_exist",
      trialId: "1",
      sponsorAddress: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
      claimedWei: "575000000000000000",
      txHash: null,
    });
    expect(claim.id).toBeDefined();
    expect(claim.status).toBe("CLAIMED");
  });
});
