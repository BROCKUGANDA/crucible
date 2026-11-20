/**
 * @file funding-verification.ts — a sponsor's money, read from the chain.
 *
 * The problem this solves, stated plainly: a sponsor console that says
 * "committed 1 ETH" while the chain holds nothing is a claim. Crucible's own
 * law separates three truths — what the chain says, what the evaluation
 * says, and what the commercial ledger says — and the commercial ledger was
 * the only one that existed. If the ledger is the only truth, a program can
 * report money it never received and distribute rewards it never paid.
 *
 * So a funding claim is verified against the chain before it counts.
 *
 * Where the numbers come from:
 *
 *   - `Arena.amountsOf(id)` → reward, fee, bond, deposited, paidOut
 *   - `Arena.partiesOf(id)` → the sponsor
 *   - `Arena.stateOf(id)`   → the status
 *
 * The SPONSOR's escrow for a trial is `reward + fee`: the reward the sponsor
 * posted plus the arena fee it paid on top. It is NOT `deposited` — that is
 * the ghost ledger of every wei the trial ever took in, which also contains
 * the agent's bond and the skeptics' stakes. Reporting `deposited` as the
 * sponsor's money would overstate every sponsor's funding by the agents'
 * bonds, which is the same class of bug as "a figure is read or it is not
 * shown".
 *
 * The fee is READ, never recomputed. The contract computed it at post time
 * from `ARENA_FEE_BPS`, and a reader that recomputes it could disagree with
 * the escrow by a wei in a way nobody would ever see.
 *
 * Money never crosses a float: every wei value here is a `bigint` in and a
 * decimal string out.
 */

/** The Arena's `Status` enum. Mode 0 (deterministic randomness) is unrelated. */
export const ARENA_STATUS = {
  Open: 0,
  Claimed: 1,
  Submitted: 2,
  Docketed: 3,
  Panel: 4,
  Settled: 5,
} as const;

/** What the chain says about one trial's money. */
export interface ChainTrialFacts {
  /** Who posted the trial. */
  sponsor: string;
  /** The reward R. */
  reward: bigint;
  /** The arena fee F, paid by the sponsor on top of R. */
  fee: bigint;
  /** Every wei the trial ever took in — including bonds and stakes. */
  deposited: bigint;
  /** Every wei credited back out. */
  paidOut: bigint;
  /** The Arena's status code. */
  status: number;
}

/**
 * The chain reader.
 *
 * An interface rather than a direct viem call so the verification can be
 * exercised against a scripted chain — and so that a test never needs a node
 * to prove that a mismatched claim is rejected.
 */
export interface ChainReader {
  /** The arena's address on this chain. */
  readonly arenaAddress: string;
  /** How many trials have been posted; ids run `1..trialCount()`. */
  trialCount(): Promise<bigint>;
  /** The money and parties of one trial. */
  trialFacts(trialId: bigint): Promise<ChainTrialFacts>;
}

/**
 * The verdict on one funding claim.
 *
 * - `verified`: the chain holds what the program claims, from that sponsor.
 * - `mismatch`: the chain was read and it says something else.
 * - `unverifiable`: the chain could not answer. Not the same as "false":
 *   a node that is down must not be recorded as a sponsor who did not pay.
 */
export type FundingVerdict = "verified" | "mismatch" | "unverifiable";

export interface FundingReceipt {
  /** The trial the claim is about. */
  trialId: string;
  /** The sponsor the claim names. */
  sponsorAddress: string;
  verdict: FundingVerdict;
  /** Why, in words a sponsor can read. Null when verified. */
  reason: string | null;
  /** What the program claimed, in wei. Null when the claim made no amount. */
  claimedWei: string | null;
  /** `reward + fee` as read from the chain. */
  observedSponsorFundingWei: string | null;
  observedRewardWei: string | null;
  observedFeeWei: string | null;
  /** Every wei the trial took in. Informational; NOT the sponsor's money. */
  observedDepositedWei: string | null;
  /** Every wei credited back out. */
  observedPaidOutWei: string | null;
  observedSponsor: string | null;
  trialStatus: number | null;
  /** When the chain was read. */
  checkedAt: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Addresses are compared case-insensitively: `0xAbC` and `0xabc` are one address. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Verify one funding claim against the chain.
 *
 * The order of the checks matters and is deliberate:
 *
 *   1. the trial exists — without that there is nothing to compare;
 *   2. the chain could be read at all — an unreachable chain is
 *      `unverifiable`, never `mismatch`;
 *   3. the trial has a sponsor;
 *   4. the trial's sponsor is the sponsor making the claim;
 *   5. the amount the chain holds is the amount claimed.
 *
 * A claim that fails (4) is a different sponsor's trial being presented as
 * this sponsor's funding, which is the failure mode that matters most: it
 * would let one sponsor's program show another's money.
 */
export async function verifySponsorFunding(input: {
  reader: ChainReader;
  trialId: bigint;
  sponsorAddress: string;
  /** What the program claims it deposited. Null means "just check it exists". */
  claimedWei?: bigint | null;
  now?: () => number;
}): Promise<FundingReceipt> {
  const { reader, trialId, sponsorAddress } = input;
  const now = input.now ?? Date.now;
  const claimedWei = input.claimedWei ?? null;

  const base: FundingReceipt = {
    trialId: trialId.toString(),
    sponsorAddress,
    verdict: "unverifiable",
    reason: null,
    claimedWei: claimedWei === null ? null : claimedWei.toString(),
    observedSponsorFundingWei: null,
    observedRewardWei: null,
    observedFeeWei: null,
    observedDepositedWei: null,
    observedPaidOutWei: null,
    observedSponsor: null,
    trialStatus: null,
    checkedAt: now(),
  };

  if (trialId < 1n) {
    return { ...base, reason: "trial ids start at 1" };
  }

  let count: bigint;
  try {
    count = await reader.trialCount();
  } catch (err) {
    return { ...base, reason: `the chain could not be read: ${message(err)}` };
  }

  if (trialId > count) {
    return {
      ...base,
      reason: `there is no trial ${trialId} on this chain (${count} posted)`,
    };
  }

  let facts: ChainTrialFacts;
  try {
    facts = await reader.trialFacts(trialId);
  } catch (err) {
    return { ...base, reason: `the chain could not be read: ${message(err)}` };
  }

  const observedFunding = facts.reward + facts.fee;
  const observed: FundingReceipt = {
    ...base,
    observedSponsorFundingWei: observedFunding.toString(),
    observedRewardWei: facts.reward.toString(),
    observedFeeWei: facts.fee.toString(),
    observedDepositedWei: facts.deposited.toString(),
    observedPaidOutWei: facts.paidOut.toString(),
    observedSponsor: facts.sponsor,
    trialStatus: facts.status,
  };

  if (!facts.sponsor || sameAddress(facts.sponsor, ZERO_ADDRESS)) {
    return { ...observed, reason: "the trial has no sponsor" };
  }

  if (!sameAddress(facts.sponsor, sponsorAddress)) {
    return {
      ...observed,
      verdict: "mismatch",
      reason:
        `the trial was posted by ${facts.sponsor}, not by ${sponsorAddress}. ` +
        `Its money is not this sponsor's money.`,
    };
  }

  if (claimedWei !== null && claimedWei !== observedFunding) {
    return {
      ...observed,
      verdict: "mismatch",
      reason:
        `the program claims ${claimedWei} wei but the chain holds ${observedFunding} wei ` +
        `for this trial (reward ${facts.reward} + fee ${facts.fee})`,
    };
  }

  return { ...observed, verdict: "verified", reason: null };
}

/**
 * The sum of what the chain holds for a set of receipts.
 *
 * Only `verified` receipts count. A receipt that could not be verified is
 * not evidence of absence, and treating it as zero would understate a
 * sponsor's funding; treating it as present would overstate it. The honest
 * answer is to report the two counts separately, which
 * `summarizeFunding` does.
 */
export function verifiedFundingWei(receipts: FundingReceipt[]): bigint {
  return receipts
    .filter((r) => r.verdict === "verified")
    .reduce((sum, r) => sum + BigInt(r.observedSponsorFundingWei ?? "0"), 0n);
}

export interface FundingSummary {
  /** How many claims were checked. */
  checked: number;
  /** How many the chain confirmed. */
  verified: number;
  /** How many the chain read and contradicted. */
  mismatched: number;
  /** How many the chain could not answer for. */
  unverifiable: number;
  /** The total the chain confirmed, in wei. */
  verifiedWei: string;
  /** The total the claims state, in wei — including unverified claims. */
  claimedWei: string;
}

/**
 * Summarise a set of receipts.
 *
 * `claimedWei` and `verifiedWei` are both reported because their difference
 * IS the finding. A console that shows only the verified number hides the
 * claim; one that shows only the claimed number hides the doubt.
 */
export function summarizeFunding(receipts: FundingReceipt[]): FundingSummary {
  let claimed = 0n;
  for (const receipt of receipts) {
    if (receipt.claimedWei !== null) claimed += BigInt(receipt.claimedWei);
  }
  return {
    checked: receipts.length,
    verified: receipts.filter((r) => r.verdict === "verified").length,
    mismatched: receipts.filter((r) => r.verdict === "mismatch").length,
    unverifiable: receipts.filter((r) => r.verdict === "unverifiable").length,
    verifiedWei: verifiedFundingWei(receipts).toString(),
    claimedWei: claimed.toString(),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
