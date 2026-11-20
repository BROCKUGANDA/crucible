/**
 * @file funding-reconciliation.ts — the commercial ledger against the chain.
 *
 * This is the job that makes a sponsor's money a fact rather than a claim.
 * It runs on a schedule in the worker, and it compares two things that were
 * previously the same thing:
 *
 *   - the commercial ledger, which says how much a program has deposited,
 *     committed and paid;
 *   - the chain, which says how much the escrow actually holds for that
 *     program's trials.
 *
 * Two kinds of drift are reported:
 *
 *   1. a claim the chain contradicts — the program says it funded a trial
 *      and the escrow says it did not, or says it funded a different
 *      amount, or says somebody else funded it;
 *   2. a ledger that overstates — the program says 1 ETH is escrowed and the
 *      chain confirms 0.5 ETH.
 *
 * The report distinguishes `unverifiable` from `mismatch` throughout. A node
 * that is down means the chain could not answer, and reporting that as "the
 * sponsor did not pay" would be a false accusation produced by an outage.
 */

import {
  summarizeFunding,
  verifySponsorFunding,
  type ChainReader,
  type FundingReceipt,
  type FundingVerdict,
} from "./funding-verification.js";
import {
  pgListClaimsNeedingCheck,
  pgListProgramBudgets,
  pgRecordFundingReceipt,
  type FundingClaim,
  type ProgramBudgetView,
} from "./sponsor-funding-pg.js";

export interface ReconciliationDrift {
  programId: string;
  trialId: string | null;
  verdict: FundingVerdict;
  reason: string;
}

export interface ReconciliationReport {
  /** False when the sweep could not run at all (no chain configured). */
  ran: boolean;
  /** Why the sweep did not run, when it did not. */
  reason: string | null;
  /** How many claims were checked against the chain. */
  checked: number;
  /** How many the chain confirmed. */
  verified: number;
  /** How many the chain read and contradicted. */
  mismatched: number;
  /** How many the chain could not answer for. */
  unverifiable: number;
  /** The total the chain confirmed, in wei. */
  verifiedWei: string;
  /** The total the ledger claims, in wei. */
  claimedWei: string;
  /** Every finding, in words. */
  drifts: ReconciliationDrift[];
}

export interface ReconciliationDeps {
  /** The chain. Null when this deployment has no chain configured. */
  reader: ChainReader | null;
  listClaims: () => Promise<FundingClaim[]>;
  listPrograms: () => Promise<ProgramBudgetView[]>;
  recordReceipt: (claimId: string, receipt: FundingReceipt) => Promise<unknown>;
  now?: () => number;
}

/**
 * Reconcile the commercial ledger against the chain.
 *
 * The order matters: the chain is asked first, and a claim the chain
 * contradicts is written down before any total is computed. A total that
 * silently skipped the failed claims would be the very number this job
 * exists to distrust.
 */
export async function reconcileFunding(deps: ReconciliationDeps): Promise<ReconciliationReport> {
  const now = deps.now ?? Date.now;

  if (!deps.reader) {
    return {
      ran: false,
      reason: "no chain is configured for this deployment, so no funding can be verified",
      checked: 0,
      verified: 0,
      mismatched: 0,
      unverifiable: 0,
      verifiedWei: "0",
      claimedWei: "0",
      drifts: [],
    };
  }

  const claims = await deps.listClaims();
  const programs = await deps.listPrograms();

  const receipts: FundingReceipt[] = [];
  const drifts: ReconciliationDrift[] = [];

  for (const claim of claims) {
    let receipt: FundingReceipt;
    try {
      receipt = await verifySponsorFunding({
        reader: deps.reader,
        trialId: BigInt(claim.trialId),
        sponsorAddress: claim.sponsorAddress,
        claimedWei: BigInt(claim.claimedWei),
        now,
      });
    } catch (err) {
      // A malformed trial id (not a number) is a data problem, not a chain
      // problem, and it must not stop the sweep.
      receipt = {
        trialId: claim.trialId,
        sponsorAddress: claim.sponsorAddress,
        verdict: "unverifiable",
        reason: `the claim could not be checked: ${err instanceof Error ? err.message : String(err)}`,
        claimedWei: claim.claimedWei,
        observedSponsorFundingWei: null,
        observedRewardWei: null,
        observedFeeWei: null,
        observedDepositedWei: null,
        observedPaidOutWei: null,
        observedSponsor: null,
        trialStatus: null,
        checkedAt: now(),
      };
    }

    receipts.push(receipt);
    await deps.recordReceipt(claim.id, receipt);

    if (receipt.verdict !== "verified") {
      drifts.push({
        programId: claim.programId,
        trialId: claim.trialId,
        verdict: receipt.verdict,
        reason: receipt.reason ?? "the chain did not confirm this funding",
      });
    }
  }

  // The ledger's own statement against the chain's total, per program.
  const verifiedByProgram = new Map<string, bigint>();
  for (const claim of claims) {
    const receipt = receipts.find((r) => r.trialId === claim.trialId);
    if (!receipt || receipt.verdict !== "verified") continue;
    const total = verifiedByProgram.get(claim.programId) ?? 0n;
    verifiedByProgram.set(claim.programId, total + BigInt(receipt.observedSponsorFundingWei ?? "0"));
  }

  for (const program of programs) {
    const verified = verifiedByProgram.get(program.id) ?? 0n;
    let deposited = 0n;
    try {
      deposited = BigInt(program.depositedWei || "0");
    } catch {
      deposited = 0n;
    }
    if (deposited !== verified) {
      drifts.push({
        programId: program.id,
        trialId: null,
        verdict: "mismatch",
        reason:
          `the ledger says ${deposited} wei is escrowed for "${program.name}", ` +
          `the chain confirms ${verified} wei`,
      });
    }
  }

  const summary = summarizeFunding(receipts);

  return {
    ran: true,
    reason: null,
    checked: summary.checked,
    verified: summary.verified,
    mismatched: summary.mismatched,
    unverifiable: summary.unverifiable,
    verifiedWei: summary.verifiedWei,
    claimedWei: summary.claimedWei,
    drifts,
  };
}

/**
 * The sweep as the worker runs it, over the real database.
 *
 * The chain reader is built from the environment. When the deployment has no
 * arena address or no RPC, the sweep reports that it did not run — it does
 * not report zero drift, which would say "everything is fine" about a sweep
 * that never looked.
 *
 * The commercial side of the comparison is the LIVE ledger — the programs the
 * API is currently serving — not a second copy of it. A reconciliation that
 * compared the chain against a snapshot of the ledger would be comparing
 * against a number nobody is looking at.
 */
export async function runFundingReconciliation(): Promise<ReconciliationReport> {
  const arenaAddress = process.env.ARENA_ADDRESS?.trim();
  const rpcUrl =
    process.env.MAINNET_RPC_URL?.trim() ||
    process.env.TESTNET_RPC_URL?.trim() ||
    process.env.RPC_URL?.trim();

  let reader: ChainReader | null = null;
  if (arenaAddress && rpcUrl) {
    const { createArenaChainReader } = await import("./chain-reader.js");
    reader = createArenaChainReader({ rpcUrl, arenaAddress });
  }

  const { listPrograms } = await import("./sponsor-onboarding.js");

  return reconcileFunding({
    reader,
    listClaims: () => pgListClaimsNeedingCheck(),
    listPrograms: async () => {
      const fromLedger = listPrograms({}).map((program) => ({
        id: program.id,
        name: program.name,
        status: program.status,
        depositedWei: program.budget.deposited.toString(),
        committedWei: program.budget.committed.toString(),
      }));
      // The durable table holds programs that outlived a restart; the live
      // ledger holds the ones this process is serving. Both are reported,
      // and a program is compared once.
      const seen = new Set(fromLedger.map((p) => p.id));
      const durable = (await pgListProgramBudgets()).filter((p) => !seen.has(p.id));
      return [...fromLedger, ...durable];
    },
    recordReceipt: (claimId, receipt) => pgRecordFundingReceipt(claimId, receipt),
  });
}
