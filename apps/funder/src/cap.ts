/**
 * Per-wallet and per-day allocation caps.
 *
 * The funder is a demo affordance: it dispenses test ETH to wallets that arrive
 * with nothing. Caps keep it from becoming a faucet anyone can drain, and every
 * allocation is logged as `requested → estimated → granted`.
 *
 * Spends go through a reservation: `reserve` checks the caps and holds the
 * amount in the same synchronous step, so two transfers in flight cannot both
 * pass against the same remaining room — the estimate-then-record split this
 * replaces let the daily cap be overspent by exactly however many requests
 * overlapped. `settle` converts the hold into the audit record; a hold that is
 * never settled expires after {@link RESERVATION_TTL_MS} and frees its room,
 * because a transfer whose outcome was never reported did not provably spend.
 *
 * State is in-memory (ADR-0008): a restart resets the counters. That is fine for
 * a demo funder — a visitor who was mid-allocation when the process restarted
 * simply retries.
 */

/** Max ETH a single wallet may receive in one allocation. */
export const MAX_PER_ALLOCATION_ETH = 0.05;

/** Max ETH a single wallet may receive in one day (UTC day). */
export const MAX_PER_WALLET_PER_DAY_ETH = 0.2;

/** Max ETH the funder may dispense in one day across all wallets. */
export const MAX_PER_DAY_ETH = 2.0;

/** How long an unsettled reservation holds cap room before it frees. */
export const RESERVATION_TTL_MS = 120_000;

/** One recorded allocation. */
export interface AllocationRecord {
  /** Lowercased wallet address. */
  wallet: string;
  /** ETH requested. */
  requested: number;
  /** ETH estimated as the gas-safe amount. */
  estimated: number;
  /** ETH actually granted (sent). */
  granted: number;
  /** ISO timestamp of the allocation. */
  at: string;
  /** Whether the grant succeeded. */
  ok: boolean;
  /** Failure reason when ok is false. */
  reason?: string | null;
  /**
   * The risk reading this allocation was sized by, and why. Kept on the record because "granted
   * 0.0125 of 0.05" is only explicable next to the factor that produced it.
   */
  risk?: { pUniqueHuman: number | null; factor: number; reason: string };
}

/** A cap hold taken by `reserve`, awaiting its transfer's outcome. */
export interface CapReservation {
  id: string;
  wallet: string;
  amount: number;
  expiresAt: number;
}

/**
 * Tracks allocations against caps. All amounts are ETH (decimal).
 */
export class CapTracker {
  private allocations: AllocationRecord[] = [];
  private reservations: CapReservation[] = [];
  private reservationSeq = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Today's date in YYYY-MM-DD (UTC). */
  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Drop holds whose transfer never reported an outcome. */
  private pruneExpired(): void {
    const t = this.now();
    this.reservations = this.reservations.filter((r) => r.expiresAt > t);
  }

  /** ETH held for this wallet by unsettled reservations. */
  private reservedToday(wallet: string): number {
    this.pruneExpired();
    return this.reservations
      .filter((r) => r.wallet === wallet)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  /** ETH held across all wallets by unsettled reservations. */
  private reservedAllToday(): number {
    this.pruneExpired();
    return this.reservations.reduce((sum, r) => sum + r.amount, 0);
  }

  /** ETH already granted to this wallet today, plus what its holds reserve. */
  private walletToday(wallet: string): number {
    const d = this.today();
    const granted = this.allocations
      .filter((a) => a.wallet === wallet && a.at.startsWith(d) && a.ok)
      .reduce((sum, a) => sum + a.granted, 0);
    return granted + this.reservedToday(wallet);
  }

  /** ETH already granted to all wallets today, plus all outstanding holds. */
  private allToday(): number {
    const d = this.today();
    const granted = this.allocations
      .filter((a) => a.at.startsWith(d) && a.ok)
      .reduce((sum, a) => sum + a.granted, 0);
    return granted + this.reservedAllToday();
  }

  /** The cap checks shared by `estimate` and `reserve`. */
  private checkCaps(
    w: string,
    requested: number,
  ): { ok: true; estimated: number } | { ok: false; reason: string } {
    if (!Number.isFinite(requested) || requested <= 0 || requested > MAX_PER_ALLOCATION_ETH) {
      return { ok: false, reason: `amount must be greater than 0 and at most ${MAX_PER_ALLOCATION_ETH} ETH` };
    }

    const walletSpent = this.walletToday(w);
    if (walletSpent + requested > MAX_PER_WALLET_PER_DAY_ETH) {
      return {
        ok: false,
        reason: `wallet ${w} would exceed the daily cap of ${MAX_PER_WALLET_PER_DAY_ETH} ETH (already spent ${walletSpent.toFixed(4)} ETH today)`,
      };
    }

    const allSpent = this.allToday();
    if (allSpent + requested > MAX_PER_DAY_ETH) {
      return {
        ok: false,
        reason: `funder daily cap of ${MAX_PER_DAY_ETH} ETH would be exceeded (already spent ${allSpent.toFixed(4)} ETH today)`,
      };
    }

    // Estimate equals request for now: a real implementation would query the CDP
    // Payments API for the fee and subtract it, refusing when the fee alone exceeds
    // the cap. The estimate is the amount we *would* grant if the transfer succeeds.
    return { ok: true, estimated: requested };
  }

  /**
   * Check whether a requested allocation would exceed any cap, without recording it.
   * Returns `{ ok: true, estimated }` or `{ ok: false, reason }`.
   */
  estimate(wallet: string, requested: number): { ok: true; estimated: number } | { ok: false; reason: string } {
    return this.checkCaps(wallet.toLowerCase(), requested);
  }

  /**
   * Check the caps and hold the amount, atomically (one synchronous step, so
   * no second request can pass against the same room). The hold counts
   * against every cap until `settle` converts it or it expires.
   */
  reserve(
    wallet: string,
    requested: number,
  ): { ok: true; estimated: number; reservationId: string } | { ok: false; reason: string } {
    const w = wallet.toLowerCase();
    const checked = this.checkCaps(w, requested);
    if (!checked.ok) return checked;
    this.reservationSeq += 1;
    const reservation: CapReservation = {
      id: `res-${this.reservationSeq}`,
      wallet: w,
      amount: checked.estimated,
      expiresAt: this.now() + RESERVATION_TTL_MS,
    };
    this.reservations.push(reservation);
    return { ok: true, estimated: checked.estimated, reservationId: reservation.id };
  }

  /**
   * Convert a hold into its audit record. A successful settle keeps the room
   * consumed (the money left); a failed one frees it.
   */
  settle(
    reservationId: string,
    outcome: {
      requested: number;
      granted: number;
      ok: boolean;
      reason?: string | null;
      risk?: AllocationRecord["risk"];
    },
  ): void {
    const held = this.reservations.find((r) => r.id === reservationId);
    if (!held) return;
    this.reservations = this.reservations.filter((r) => r.id !== reservationId);
    this.record(
      held.wallet,
      outcome.requested,
      held.amount,
      outcome.granted,
      outcome.ok,
      outcome.reason,
      outcome.risk,
    );
  }

  /** Record a completed allocation. */
  record(
    wallet: string,
    requested: number,
    estimated: number,
    granted: number,
    ok: boolean,
    reason?: string | null,
    risk?: AllocationRecord["risk"],
  ): void {
    this.allocations.push({
      wallet: wallet.toLowerCase(),
      requested,
      estimated,
      granted,
      at: new Date(this.now()).toISOString(),
      ok,
      reason,
      ...(risk ? { risk } : {}),
    });
  }

  /** All allocations for inspection (testing / debug). */
  list(): AllocationRecord[] {
    return [...this.allocations];
  }

  /** Outstanding holds for inspection (testing / debug). */
  holds(): CapReservation[] {
    this.pruneExpired();
    return [...this.reservations];
  }
}
