import { UNKNOWN } from "@/lib/clock";
import { formatDuration, formatEth } from "@/lib/forge";

/**
 * The escrow explorer's view model (gate 838).
 *
 * The API answers with the contract's three books; this file decides what a reader sees for
 * each, and it is separate from the page for the same reason `lib/replay/view.ts` is: the
 * interesting decisions — unknown is not zero, a lock with no clock is decided by a verdict,
 * an address is not a number — are all testable without a renderer, and a page that inlines
 * them cannot be tested at all.
 */

export interface EscrowHoldingJson {
  trialId: number;
  role: "sponsor" | "operator" | "skeptic";
  kind: "reward" | "bond" | "break stake";
  eth: string;
  release: string;
  reclaimableAt: number | null;
}

export interface EscrowJson {
  wallet: string;
  escrowAddress: string | null;
  held: EscrowHoldingJson[];
  heldEth: string;
  stakes: { agentId: number; eth: string }[];
  stakedEth: string;
  withdrawableEth: string | null;
  settledTrialIds: number[];
  chainNow: number | null;
  creditSource: { configured: boolean; reason: string | null };
}

export interface EscrowColumn {
  label: string;
  /** already formatted, and `—` when the figure was not read — never a zero standing in for one */
  value: string;
  note: string;
}

/** Who this wallet was on a given trial, in the words a reader uses about their own money. */
export function roleWords(role: EscrowHoldingJson["role"]): string {
  if (role === "sponsor") return "you funded it";
  if (role === "operator") return "you took it on";
  return "you filed a break on it";
}

/**
 * The three books, side by side.
 *
 * The order is the one a holder cares about: what is not yours yet, what is yours but still
 * in the contract, and what you can move with one call. The third column is the only one that
 * can be `—`, and when it is, the note says why rather than leaving a blank that reads as an
 * empty account.
 */
export function columnsOf(escrow: EscrowJson): EscrowColumn[] {
  const claimNote =
    escrow.withdrawableEth !== null
      ? "withdraw it in one call from your wallet — the contract never sends it to you"
      : escrow.creditSource.configured
        ? (escrow.creditSource.reason ?? "the escrow was reached but this figure was not read")
        : (escrow.creditSource.reason ?? "this host does not read claims from the chain");

  return [
    {
      label: "Locked in live trials",
      value: formatEth(escrow.heldEth),
      note:
        escrow.held.length === 0
          ? "nothing locked — no trial of yours is open right now"
          : `${escrow.held.length} ${escrow.held.length === 1 ? "trial" : "trials"} held by ${escrow.escrowAddress ?? "the escrow contract"}`,
    },
    {
      label: "Free stake on your agents",
      value: formatEth(escrow.stakedEth),
      note:
        escrow.stakes.length === 0
          ? "no agent registered to this address"
          : "not locked to any trial — release it with unstake, then withdraw it",
    },
    { label: "Claimable now", value: formatEth(escrow.withdrawableEth), note: claimNote },
  ];
}

export interface EscrowRow {
  trialId: number;
  href: string;
  who: string;
  what: string;
  amount: string;
  release: string;
  /** what the clock says about releasing it, or why the clock has nothing to say */
  timing: string;
}

/**
 * One row per lock, with the countdown the chain's own clock supports.
 *
 * `reclaimableAt` is null for anything a verdict releases rather than a deadline, and that is
 * a different sentence: a reader looking at a trial under dispute needs to know the panel is
 * the exit, not that a timer ran out.
 */
export function rowsOf(escrow: EscrowJson): EscrowRow[] {
  return escrow.held.map((h) => ({
    trialId: h.trialId,
    href: `/trials/${h.trialId}`,
    who: roleWords(h.role),
    what: h.kind,
    amount: formatEth(h.eth),
    release: h.release,
    timing: timingNote(h.reclaimableAt, escrow.chainNow),
  }));
}

export function timingNote(reclaimableAt: number | null, chainNow: number | null): string {
  if (reclaimableAt === null) return "released by the verdict, not the clock";
  if (chainNow === null) return `past the deadline at ${UNKNOWN} — this host has no chain clock`;
  const remaining = reclaimableAt - chainNow;
  if (remaining <= 0) return "past its deadline — reclaimable now, by anyone";
  return `deadline in ${formatDuration(remaining)}`;
}

/** A settled trial is where a claim came from; the row links out rather than restating a number. */
export function settledNote(escrow: EscrowJson): string {
  const n = escrow.settledTrialIds.length;
  if (n === 0) return "no settled trial has named this address";
  return `${n} settled ${n === 1 ? "trial" : "trials"} have already moved this address's money into a claim or a stake`;
}
