/**
 * @file sponsor-funding-pg.ts — the durable record of a sponsor's funding.
 *
 * Two tables, one job:
 *
 *   - `sponsor_funding_claims` — what the program claims it funded.
 *   - `sponsor_funding_receipts` — what the chain said when the claim was
 *     checked, written by the reconciliation job.
 *
 * The receipt is appended, never overwritten: a sponsor who was verified in
 * March and is drifting in July needs both facts, and a table that keeps
 * only the latest answer cannot show that the answer changed.
 *
 * The latest receipt per claim is what the console shows; the history is
 * what an auditor asks for.
 *
 * Every wei value is TEXT. Money never crosses a float — not in the
 * database, not on the way in, and not in the summary that is computed from
 * these rows.
 */

import { getPool } from "@crucible/agent-security";
import type { FundingReceipt } from "./funding-verification.js";

export type ClaimStatus = "CLAIMED" | "VERIFIED" | "MISMATCH" | "UNVERIFIABLE";

export interface FundingClaim {
  id: string;
  programId: string;
  /** The tenant that owns the program; the RLS boundary. */
  orgId: string;
  trialId: string;
  sponsorAddress: string;
  /** What the program claims, in wei. */
  claimedWei: string;
  txHash: string | null;
  status: ClaimStatus;
  createdAt: number;
  updatedAt: number;
}

export interface StoredReceipt {
  id: string;
  claimId: string;
  verdict: "VERIFIED" | "MISMATCH" | "UNVERIFIABLE";
  reason: string | null;
  observedSponsorFundingWei: string | null;
  observedRewardWei: string | null;
  observedFeeWei: string | null;
  observedDepositedWei: string | null;
  observedPaidOutWei: string | null;
  observedSponsor: string | null;
  trialStatus: number | null;
  checkedAt: number;
}

function rowToClaim(r: Record<string, unknown>): FundingClaim {
  return {
    id: r.id as string,
    programId: r.program_id as string,
    orgId: r.org_id as string,
    trialId: r.trial_id as string,
    sponsorAddress: r.sponsor_address as string,
    claimedWei: r.claimed_wei as string,
    txHash: (r.tx_hash as string | null) ?? null,
    status: r.status as ClaimStatus,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToReceipt(r: Record<string, unknown>): StoredReceipt {
  return {
    id: r.id as string,
    claimId: r.claim_id as string,
    verdict: r.verdict as StoredReceipt["verdict"],
    reason: (r.reason as string | null) ?? null,
    observedSponsorFundingWei: (r.observed_sponsor_funding_wei as string | null) ?? null,
    observedRewardWei: (r.observed_reward_wei as string | null) ?? null,
    observedFeeWei: (r.observed_fee_wei as string | null) ?? null,
    observedDepositedWei: (r.observed_deposited_wei as string | null) ?? null,
    observedPaidOutWei: (r.observed_paid_out_wei as string | null) ?? null,
    observedSponsor: (r.observed_sponsor as string | null) ?? null,
    trialStatus: r.trial_status === null || r.trial_status === undefined ? null : Number(r.trial_status),
    checkedAt: Number(r.checked_at),
  };
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Record what a program claims it funded.
 *
 * The claim is upserted on (program_id, trial_id): re-claiming the same trial
 * updates the claim rather than adding a second one, because two claims for
 * one trial are one of two things — a data-entry mistake or a fraud — and
 * both deserve to be visible as a single contested line rather than hidden
 * behind a duplicate.
 */
export async function pgRecordFundingClaim(input: {
  programId: string;
  orgId: string;
  trialId: string;
  sponsorAddress: string;
  claimedWei: string;
  txHash?: string | null;
}): Promise<FundingClaim> {
  const pool = getPool();
  const now = Date.now();
  const r = await pool.query(
    `INSERT INTO sponsor_funding_claims
       (id, program_id, org_id, trial_id, sponsor_address, claimed_wei, tx_hash, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLAIMED', $8, $8)
     ON CONFLICT (program_id, trial_id) DO UPDATE SET
       org_id = EXCLUDED.org_id,
       sponsor_address = EXCLUDED.sponsor_address,
       claimed_wei = EXCLUDED.claimed_wei,
       tx_hash = EXCLUDED.tx_hash,
       status = 'CLAIMED',
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      id("claim"),
      input.programId,
      input.orgId,
      input.trialId,
      input.sponsorAddress,
      input.claimedWei,
      input.txHash ?? null,
      now,
    ],
  );
  return rowToClaim(r.rows[0]);
}

export async function pgListFundingClaims(programId: string): Promise<FundingClaim[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT * FROM sponsor_funding_claims WHERE program_id = $1 ORDER BY created_at ASC`,
    [programId],
  );
  return r.rows.map(rowToClaim);
}

/**
 * Every claim that has not yet been confirmed by the chain.
 *
 * The reconciliation job reads this list. A claim that was verified stays
 * in the table and is re-checked on the next sweep, because a trial that
 * was open when it was paid can be cancelled later, and the chain's answer
 * changes.
 */
export async function pgListClaimsNeedingCheck(): Promise<FundingClaim[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT c.* FROM sponsor_funding_claims c
      WHERE c.status IN ('CLAIMED','UNVERIFIABLE','MISMATCH')
      ORDER BY c.updated_at ASC
      LIMIT 500`,
  );
  return r.rows.map(rowToClaim);
}

/**
 * Write what the chain said, and move the claim to the matching status.
 *
 * The receipt is inserted first: if the claim's status update then fails,
 * the history still has the answer and the next sweep re-checks. The other
 * order would leave a claim marked VERIFIED with no receipt behind it.
 */
export async function pgRecordFundingReceipt(
  claimId: string,
  receipt: FundingReceipt,
): Promise<StoredReceipt> {
  const pool = getPool();
  const status = receipt.verdict.toUpperCase() as ClaimStatus;
  const r = await pool.query(
    `INSERT INTO sponsor_funding_receipts
       (id, claim_id, verdict, reason, observed_sponsor_funding_wei, observed_reward_wei,
        observed_fee_wei, observed_deposited_wei, observed_paid_out_wei, observed_sponsor,
        trial_status, checked_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
     RETURNING *`,
    [
      id("receipt"),
      claimId,
      status,
      receipt.reason,
      receipt.observedSponsorFundingWei,
      receipt.observedRewardWei,
      receipt.observedFeeWei,
      receipt.observedDepositedWei,
      receipt.observedPaidOutWei,
      receipt.observedSponsor,
      receipt.trialStatus,
      receipt.checkedAt,
    ],
  );
  await pool.query(`UPDATE sponsor_funding_claims SET status = $2, updated_at = $3 WHERE id = $1`, [
    claimId,
    status,
    receipt.checkedAt,
  ]);
  return rowToReceipt(r.rows[0]);
}

/** The most recent receipt for each claim of a program. */
export async function pgLatestReceipts(programId: string): Promise<StoredReceipt[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT DISTINCT ON (r.claim_id) r.*
       FROM sponsor_funding_receipts r
       JOIN sponsor_funding_claims c ON c.id = r.claim_id
      WHERE c.program_id = $1
      ORDER BY r.claim_id, r.checked_at DESC, r.seq DESC`,
    [programId],
  );
  return r.rows.map(rowToReceipt);
}

/** The full receipt history for a program's claims. */
export async function pgReceiptHistory(programId: string): Promise<StoredReceipt[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT r.* FROM sponsor_funding_receipts r
       JOIN sponsor_funding_claims c ON c.id = r.claim_id
      WHERE c.program_id = $1
      ORDER BY r.checked_at DESC`,
    [programId],
  );
  return r.rows.map(rowToReceipt);
}

/**
 * What the commercial ledger believes about each program's money.
 *
 * `depositedWei` is the ledger's own statement that this much is escrowed.
 * It is the number the reconciliation compares the chain against, and it is
 * exactly the number that used to be believed on its own.
 */
export interface ProgramBudgetView {
  id: string;
  name: string;
  status: string;
  /** What the ledger says is escrowed, in wei. */
  depositedWei: string;
  /** What the ledger says was committed, in wei. */
  committedWei: string;
}

export async function pgListProgramBudgets(): Promise<ProgramBudgetView[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, name, status, deposited_wei, committed_wei FROM sponsor_programs`,
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    status: row.status as string,
    depositedWei: row.deposited_wei as string,
    committedWei: row.committed_wei as string,
  }));
}
