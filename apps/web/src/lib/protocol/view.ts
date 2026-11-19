/**
 * @file view.ts — the protocol/ownership page's view model.
 *
 * Two display rules from the repository's own list, applied to a domain where
 * getting them wrong is expensive:
 *
 *   1. **A figure is read or it is not shown.** Unknown renders `—`, never `0`.
 *      Zero is a measurement; nothing is not. A reserve of `0%` would tell an
 *      investor the cap is unallocated when the truth is that nobody has
 *      calculated it yet.
 *   2. **Plain words at the action, no jargon.** `5% · 500 bps` rather than
 *      `500 bps`; "no chain read has happened here" rather than a boolean named
 *      `canonical`.
 *
 * Everything here is pure, so the gates are tests rather than a browser run —
 * the same shape the rest of this app's view modules use (there is no React
 * renderer in this repository).
 */

/** The em dash this app renders for an absent figure. */
export const UNKNOWN = "—";

export type StampModeView = "disabled" | "sandbox" | "manual_review" | "production" | "unknown";

export interface OwnershipResponse {
  mode?: string;
  sandbox?: boolean;
  note?: string;
  docs?: string[];
  production?: { unlocked?: boolean; reason?: string | null; missing?: string[]; mismatches?: unknown[] };
}

export interface TransparencyResponse {
  transparency?: {
    issuer?: { legalEntityName: string; jurisdictionCode: string; status: string } | null;
    totalNetworkTokens?: string | null;
    investorReserveBps?: string | null;
    teamAllocationBps?: string | null;
    tokenMint?: string | null;
    daoTreasuryAddress?: string | null;
    governanceUrl?: string | null;
    holderCount?: number | null;
    allocatedCount?: number | null;
  } | null;
}

export interface ModeView {
  mode: StampModeView;
  /** True when the surface is live at all. */
  offered: boolean;
  /** The sentence a visitor reads about what this host may do. */
  notice: string;
  /** The paragraph under the notice, when the host has one. */
  note: string | null;
  /** True only when the production manifest matched. */
  productionUnlocked: boolean;
}

/**
 * Read the mode out of the API's answer.
 *
 * An answer this module does not recognise is `unknown`, not `production`: the
 * failure direction for a legal domain is closed.
 */
export function modeView(response: OwnershipResponse | null): ModeView {
  if (!response) {
    return {
      mode: "unknown",
      offered: false,
      notice: "This host did not answer the ownership read.",
      note: null,
      productionUnlocked: false,
    };
  }
  const raw = response.mode;
  const mode: StampModeView =
    raw === "sandbox" || raw === "manual_review" || raw === "production" || raw === "disabled"
      ? raw
      : "unknown";

  const productionUnlocked = mode === "production" && response.production?.unlocked === true;

  if (mode === "sandbox") {
    return {
      mode,
      offered: true,
      notice: "Sandbox. Nothing on this page is a legal agreement, and no money moves.",
      note: response.note ?? null,
      productionUnlocked: false,
    };
  }
  if (mode === "manual_review") {
    return {
      mode,
      offered: true,
      notice: "Manual review. A named reviewer records evidence; acceptance and delivery stay closed.",
      note: response.note ?? null,
      productionUnlocked: false,
    };
  }
  if (mode === "production") {
    return {
      mode,
      offered: true,
      productionUnlocked,
      notice: productionUnlocked
        ? "Live. The signed preflight manifest matches this host's configuration."
        : "Production was requested but the preflight manifest does not match this host, so nothing irreversible runs.",
      note: response.production?.reason ?? response.note ?? null,
    };
  }
  if (mode === "disabled") {
    return {
      mode,
      offered: false,
      notice: "The protocol-ownership surface is switched off on this host.",
      note: response.note ?? null,
      productionUnlocked: false,
    };
  }
  return {
    mode: "unknown",
    offered: false,
    notice: "This host answered with a mode this page does not recognise, so it shows nothing.",
    note: null,
    productionUnlocked: false,
  };
}

/** Basis points as a percentage, keeping the chain's own unit beside it. */
export function formatBps(bps: string | null | undefined): string {
  if (bps === null || bps === undefined || bps === "") return UNKNOWN;
  if (!/^-?[0-9]+$/.test(bps)) return UNKNOWN;
  const value = BigInt(bps);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const fraction = abs % 100n;
  // Two decimal places, truncated: printing a share higher than the chain holds
  // overstates what a holder is owed.
  const fractionText = fraction.toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fractionText}% · ${bps} bps`;
}

/**
 * A token amount, grouped, with the raw base units available beside it.
 *
 * Grouping is done on the digit string rather than through `Number`, because a
 * token supply is larger than a double can hold exactly and a rounding error in
 * a supply figure is a rounding error in every portion computed from it.
 */
export function formatTokenAmount(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return UNKNOWN;
  if (!/^[0-9]+$/.test(raw)) return UNKNOWN;
  const grouped = raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return grouped;
}

/** A count: unknown when the API did not measure it, never zero. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  if (!Number.isFinite(value)) return UNKNOWN;
  return String(value);
}

export interface PublicFacts {
  legalEntityName: string;
  jurisdictionCode: string;
  status: string;
  totalNetworkTokens: string;
  investorReserve: string;
  teamAllocation: string;
  tokenMint: string;
  daoTreasury: string;
  holders: string;
  allocated: string;
  /** True when no issuer has been published at all. */
  empty: boolean;
}

/**
 * The public projection.
 *
 * It shows the issuer's name, jurisdiction and status — all published facts —
 * and it shows nothing about any holder: not a name, not a purchase price, not
 * a portion. The blueprint is explicit that the investor reserve may be
 * published in aggregate and the cap table may not.
 */
export function publicFacts(response: TransparencyResponse | null): PublicFacts {
  const t = response?.transparency ?? null;
  if (!t || !t.issuer) {
    return {
      legalEntityName: UNKNOWN,
      jurisdictionCode: UNKNOWN,
      status: UNKNOWN,
      totalNetworkTokens: UNKNOWN,
      investorReserve: UNKNOWN,
      teamAllocation: UNKNOWN,
      tokenMint: UNKNOWN,
      daoTreasury: UNKNOWN,
      holders: UNKNOWN,
      allocated: UNKNOWN,
      empty: true,
    };
  }
  return {
    legalEntityName: t.issuer.legalEntityName,
    jurisdictionCode: t.issuer.jurisdictionCode,
    status: t.issuer.status,
    totalNetworkTokens: formatTokenAmount(t.totalNetworkTokens ?? null),
    investorReserve: formatBps(t.investorReserveBps ?? null),
    teamAllocation: formatBps(t.teamAllocationBps ?? null),
    tokenMint: t.tokenMint ?? UNKNOWN,
    daoTreasury: t.daoTreasuryAddress ?? UNKNOWN,
    holders: formatCount(t.holderCount ?? null),
    allocated: formatCount(t.allocatedCount ?? null),
    empty: false,
  };
}

/** The cap, stated once, so a reader does not have to know the template. */
export const RESERVE_CAP_TEXT = "The investor reserve may not exceed 20% · 2000 bps of total network tokens.";

/** The lock-up, stated once, with the anchor the schedule actually uses. */
export const LOCKUP_TEXT =
  "Delivered investor tokens unlock in 24 monthly releases, beginning the first day of the month after the delivery date, in Pacific time.";

/**
 * The bands a launch has to sit inside, as sentences rather than numbers.
 *
 * These are the template's own bands; the reconciliation against MetaDAO's
 * current sale, liquidity and performance parameters is a separate, human step
 * and is not asserted here.
 */
export const ALLOCATION_BANDS = [
  "Investor reserve: at most 20% · 2000 bps",
  "Founder and service providers: between 10% · 1000 bps and 40% · 4000 bps",
  "Founder and service-provider unlock terms must be at least as onerous as an investor's",
] as const;

/**
 * What each surface refuses to do, in the words a reviewer can check against.
 *
 * A boundary that is only in the code is a boundary a reader has to take on
 * trust; these are the same statements the routes enforce.
 */
export const BOUNDARIES = [
  "STAMP is not a trial reward, a reputation score or an achievement credential.",
  "The protocol token is not an Engram, and an Engram is not an investment.",
  "Trial escrow on EVM never holds investor money, and the token treasury never holds trial escrow.",
  "The API holds no chain key: payments are observed, deliveries are verified, neither is signed here.",
  "An EVM wallet and a Solana wallet are not interchangeable, and no bridge between them is implied.",
] as const;

/** The delivery checklist, in the order the verifier runs it. */
export const DELIVERY_CHECKS = [
  "The mint address is the one the agreement names.",
  "The token amount matches to the base unit.",
  "The destination account belongs to the wallet the holder proved.",
  "The lock-up account and its beneficiary are the ones recorded.",
  "The transaction has reached the finality the agreement requires.",
  "The record on this host reconciles with the balance on chain.",
] as const;

/** A short, honest description of what evidence state means. */
export function evidenceSentence(source: "runner" | "client" | "none" | null | undefined): string {
  if (source === "runner") return "Verdict computed from the runner's observations.";
  if (source === "client") return "Verdict computed from evidence this host was told to trust (demo mode).";
  if (source === "none") return "No evidence was reported, so this run has no verdict and no score.";
  return UNKNOWN;
}