/**
 * Per-wallet and per-day allocation caps.
 *
 * The funder is a demo affordance: it dispenses test ETH to wallets that arrive
 * with nothing. Caps keep it from becoming a faucet anyone can drain, and every
 * allocation is logged as `requested → estimated → granted`.
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
}

/**
 * Tracks allocations against caps. All amounts are ETH (decimal).
 */
export class CapTracker {
  private allocations: AllocationRecord[] = [];

  /** Today's date in YYYY-MM-DD (UTC). */
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** ETH already granted to this wallet today. */
  private walletToday(wallet: string): number {
    const d = this.today();
    return this.allocations
      .filter((a) => a.wallet === wallet && a.at.startsWith(d) && a.ok)
      .reduce((sum, a) => sum + a.granted, 0);
  }

  /** ETH already granted to all wallets today. */
  private allToday(): number {
    const d = this.today();
    return this.allocations
      .filter((a) => a.at.startsWith(d) && a.ok)
      .reduce((sum, a) => sum + a.granted, 0);
  }

  /**
   * Check whether a requested allocation would exceed any cap, without recording it.
   * Returns `{ ok: true, estimated }` or `{ ok: false, reason }`.
   */
  estimate(wallet: string, requested: number): { ok: true; estimated: number } | { ok: false; reason: string } {
    const w = wallet.toLowerCase();

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

  /** Record a completed allocation. */
  record(wallet: string, requested: number, estimated: number, granted: number, ok: boolean, reason?: string | null): void {
    this.allocations.push({
      wallet: wallet.toLowerCase(),
      requested,
      estimated,
      granted,
      at: new Date().toISOString(),
      ok,
      reason,
    });
  }

  /** All allocations for inspection (testing / debug). */
  list(): AllocationRecord[] {
    return [...this.allocations];
  }
}
