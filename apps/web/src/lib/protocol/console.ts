/**
 * @file console.ts — the issuer console and investor portal, as pure functions.
 *
 * The two surfaces render records this browser did not compute: a portion that
 * came out of a frozen Schedule 2 snapshot, a payment an operator verified, a
 * monthly release the contract's schedule produced. So the rules are the same
 * ones `/assay` and `/clock` follow, applied to a different set of numbers:
 *
 *   - **Unknown renders `—`, never `0`.** A missing portion is not zero tokens,
 *     and a payment nobody observed is not a payment of nothing.
 *   - **Integer base units, never a float.** `baseUnits` refuses a string with a
 *     decimal point rather than parsing it: a decimal in a token amount means
 *     something upstream already crossed the boundary this file exists to keep.
 *   - **Plain words at the action.** `500` is printed `5% · 500 bps`, the same
 *     rule the money warning follows.
 *
 * Everything here is asserted against fixtures in
 * `apps/web/test/protocol-console.test.ts`; the pages below are thin.
 */

export const UNKNOWN = "—";

/** A base-unit amount, grouped. Refuses anything that is not an integer string. */
export function baseUnits(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  const text = String(value).trim();
  if (text === "" || !/^-?\d+$/.test(text)) return UNKNOWN;
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** Basis points in words: `5% · 500 bps`. Integer arithmetic only. */
export function bps(value: string | number | null | undefined): string {
  const n = asInt(value);
  if (n === null) return UNKNOWN;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  const percent = frac === 0 ? `${whole}` : `${whole}.${String(frac).padStart(2, "0")}`;
  return `${sign}${percent}% · ${sign}${abs} bps`;
}

/** A unix-ms instant as one ISO UTC string, the site's single date format. */
export function when(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return UNKNOWN;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return UNKNOWN;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A digest, short enough for a table cell. The caller keeps the full value. */
export function shortDigest(value: string | null | undefined): string {
  if (!value) return UNKNOWN;
  return value.length <= 14 ? value : `${value.slice(0, 10)}…`;
}

function asInt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Mode                                                                 */
/* ------------------------------------------------------------------ */

export type StampMode = "disabled" | "sandbox" | "manual_review" | "production";
export type BannerTone = "cool" | "gold" | "sear";

export interface ModeBanner {
  tone: BannerTone;
  title: string;
  body: string;
}

/**
 * What this host is allowed to do, said on the page rather than inferred.
 *
 * The mode is the API's, not the browser's: a page that guessed "production"
 * from `NODE_ENV` would be a second source of truth for the one decision that
 * must have exactly one.
 */
export function modeBanner(mode: string | null | undefined): ModeBanner {
  switch (mode) {
    case "sandbox":
      return {
        tone: "gold",
        title: "Sandbox — no legal or financial effect",
        body: "Records here are fixtures. No payment is accepted and no token is delivered, and the API refuses both whatever this page offers.",
      };
    case "manual_review":
      return {
        tone: "cool",
        title: "Manual review — evidence only",
        body: "A reviewer can record instruments, signatures, payments and notices. Payment acceptance and token delivery stay off until the signed production manifest matches this host.",
      };
    case "production":
      return {
        tone: "cool",
        title: "Production — the signed manifest matched",
        body: "Irreversible actions are enabled because the preflight manifest compared clean against this host's configuration. The API still holds no signing key.",
      };
    case "disabled":
      return {
        tone: "sear",
        title: "STAMP is switched off on this host",
        body: "The protocol-ownership surface answers 404 while STAMP_MODE is unset or disabled. Nothing below can act.",
      };
    case null:
    case undefined:
      // Unreachable is not disabled. The page could not read the mode, and
      // saying "switched off" would be a claim about the host that the browser
      // never measured.
      return {
        tone: "sear",
        title: "This host's mode could not be read",
        body: "The API did not answer, so this page cannot say what the host may do. Nothing is offered as if it could act.",
      };
    default:
      return {
        tone: "sear",
        title: `Unknown STAMP mode "${mode}"`,
        body: "The API answered with a mode this page does not recognise. Treating it as off is the only safe reading.",
      };
  }
}

/* ------------------------------------------------------------------ */
/* Issuer readiness                                                     */
/* ------------------------------------------------------------------ */

const ISSUER_LADDER = [
  "DRAFT",
  "COUNSEL_REVIEW",
  "ENTITY_READY",
  "IP_PERIMETER_VERIFIED",
  "META_DAO_REVIEW",
  "LISTED",
  "ACTIVE",
] as const;

/**
 * The one state this issuer may move to next, or `null` at the end.
 *
 * The console offers a single "advance" button rather than a free choice of
 * states: the ladder is a sequence of approvals, and a menu of every state
 * invites a reviewer to skip one. The API still refuses an illegal move; this
 * keeps the page from proposing it.
 */
export function nextIssuerState(current: string | null | undefined): string | null {
  const index = ISSUER_LADDER.indexOf(current as (typeof ISSUER_LADDER)[number]);
  if (index < 0 || index === ISSUER_LADDER.length - 1) return null;
  return ISSUER_LADDER[index + 1]!;
}

/* ------------------------------------------------------------------ */
/* Instruments                                                          */
/* ------------------------------------------------------------------ */

export interface InstrumentLike {
  id: string;
  holderPartyId: string;
  status: string;
  proRataBps: string;
  purchasePriceMinor: string;
  currency: string;
  signedDocumentSha256?: string | null;
  documentSha256?: string;
}

export interface AllocationLike {
  holderId: string;
  holderPortionTokens: string;
  effectiveProRataBps: string;
}

export interface InstrumentRow {
  id: string;
  holder: string;
  status: string;
  proRata: string;
  price: string;
  portion: string;
  signed: string;
  tone: BannerTone;
}

const STATUS_TONE: Record<string, BannerTone> = {
  DRAFT: "gold",
  COUNSEL_APPROVED: "gold",
  OFFERED: "gold",
  SIGNED: "cool",
  PAYMENT_PENDING: "gold",
  FUNDED: "cool",
  ELIGIBLE_FOR_DELIVERY: "cool",
  DELIVERY_REQUESTED: "gold",
  DELIVERY_APPROVED: "gold",
  DELIVERED: "cool",
  VESTING_ACTIVE: "cool",
  VESTING_COMPLETE: "cool",
  CANCELLED: "sear",
  EXPIRED: "sear",
  SUPERSEDED: "sear",
  DISPUTED: "sear",
};

/**
 * One row per instrument, with the portion read from the frozen snapshot.
 *
 * The portion is looked up by the *holder*, because that is how the snapshot is
 * keyed: a holder's effective percentage depends on everybody else's raw one, so
 * a per-instrument number would be a second, wrong answer to the same question.
 */
export function instrumentRows(
  instruments: readonly InstrumentLike[],
  allocations: readonly AllocationLike[] = [],
): InstrumentRow[] {
  const byHolder = new Map(allocations.map((a) => [a.holderId, a]));
  return instruments.map((instrument) => {
    const allocation = byHolder.get(instrument.holderPartyId);
    return {
      id: instrument.id,
      holder: instrument.holderPartyId,
      status: instrument.status,
      proRata: bps(allocation?.effectiveProRataBps ?? instrument.proRataBps),
      price: `${baseUnits(instrument.purchasePriceMinor)} ${instrument.currency || ""}`.trim(),
      portion: baseUnits(allocation?.holderPortionTokens),
      signed: instrument.signedDocumentSha256 ? "signed" : "not signed",
      tone: STATUS_TONE[instrument.status] ?? "gold",
    };
  });
}

/* ------------------------------------------------------------------ */
/* Payments and notices                                                 */
/* ------------------------------------------------------------------ */

export interface PaymentLike {
  id: string;
  instrumentId: string;
  amountBaseUnits: string;
  transactionSignature: string;
  finalityStatus: string;
  canonicalityStatus: string;
  verifiedAt?: number | null;
  refusalReason?: string | null;
}

export interface PaymentRow {
  id: string;
  instrument: string;
  amount: string;
  finality: string;
  canonical: string;
  state: string;
  tone: BannerTone;
}

export function paymentRows(payments: readonly PaymentLike[]): PaymentRow[] {
  return payments.map((payment) => {
    const refused = Boolean(payment.refusalReason);
    const verified = typeof payment.verifiedAt === "number";
    return {
      id: payment.id,
      instrument: payment.instrumentId,
      amount: baseUnits(payment.amountBaseUnits),
      finality: payment.finalityStatus,
      canonical: payment.canonicalityStatus,
      state: refused ? "refused" : verified ? "verified" : "observed, unverified",
      tone: refused ? "sear" : verified ? "cool" : "gold",
    };
  });
}

export interface NoticeLike {
  id: string;
  noticeType: string;
  effectiveAt: number;
  requiredDeliveryAt: number;
  deliveredAt?: number | null;
  status: string;
}

export interface NoticeRow {
  id: string;
  type: string;
  effective: string;
  due: string;
  delivered: string;
  status: string;
  tone: BannerTone;
}

export function noticeRows(notices: readonly NoticeLike[], now: number): NoticeRow[] {
  return notices.map((notice) => {
    const overdue =
      typeof notice.deliveredAt !== "number" && notice.requiredDeliveryAt > 0 && notice.requiredDeliveryAt < now;
    return {
      id: notice.id,
      type: notice.noticeType,
      effective: when(notice.effectiveAt),
      due: when(notice.requiredDeliveryAt),
      delivered: notice.deliveredAt ? when(notice.deliveredAt) : "not delivered",
      status: overdue ? `${notice.status} · overdue` : notice.status,
      tone: overdue ? "sear" : notice.deliveredAt ? "cool" : "gold",
    };
  });
}

/* ------------------------------------------------------------------ */
/* Vesting                                                              */
/* ------------------------------------------------------------------ */

export interface VestingLike {
  deliveredAmountBaseUnits: string;
  months: number;
  firstReleaseAt: number;
  monthlyVector: { index: number; amountBaseUnits: string; releaseAt: number }[];
  conserved: boolean;
}

export interface VestingStateLike {
  releasedBaseUnits: string;
  remainingLockedBaseUnits: string;
  nextReleaseAt: number | null;
  fullyUnlocked: boolean;
}

export interface VestingSummary {
  delivered: string;
  released: string;
  locked: string;
  months: string;
  nextRelease: string;
  conserved: string;
  complete: string;
}

export function vestingSummary(
  vesting: VestingLike | null | undefined,
  state: VestingStateLike | null | undefined,
): VestingSummary {
  return {
    delivered: baseUnits(vesting?.deliveredAmountBaseUnits),
    released: baseUnits(state?.releasedBaseUnits),
    locked: baseUnits(state?.remainingLockedBaseUnits),
    months: vesting?.months === undefined ? UNKNOWN : String(vesting.months),
    nextRelease: state?.nextReleaseAt ? when(state.nextReleaseAt) : state?.fullyUnlocked ? "none — fully released" : UNKNOWN,
    conserved: vesting ? (vesting.conserved ? "yes" : "no") : UNKNOWN,
    complete: state ? (state.fullyUnlocked ? "yes" : "no") : UNKNOWN,
  };
}

export interface MonthlyRow {
  index: string;
  date: string;
  amount: string;
  released: string;
}

/** The 24 monthly releases, with whether each has happened at `now`. */
export function monthlyRows(vesting: VestingLike | null | undefined, now: number): MonthlyRow[] {
  if (!vesting) return [];
  return vesting.monthlyVector.map((release) => ({
    index: String(release.index),
    date: when(release.releaseAt),
    amount: baseUnits(release.amountBaseUnits),
    released: release.releaseAt <= now ? "released" : "locked",
  }));
}

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

export interface ApiErrorBody {
  error?: string;
  code?: string;
  reasons?: { code?: string; detail?: string }[];
}

/**
 * What a failed call means for the person at the keyboard.
 *
 * 401 and 403 are different sentences: "sign in" is actionable, "this wallet is
 * not on the reviewer list" is a fact about the wallet. Collapsing them into
 * "unauthorized" leaves an operator with nothing to do.
 */
export function apiFailure(status: number, body: ApiErrorBody | null | undefined): string {
  const code = body?.code ?? "";
  const detail = body?.error ?? "";
  const reasons = (body?.reasons ?? [])
    .map((reason) => reason.code ?? reason.detail ?? "")
    .filter(Boolean)
    .join(", ");

  if (status === 401) return "Sign in with the wallet this issuer has on its reviewer list.";
  if (status === 403 && code === "stamp_no_reviewers") {
    return "No reviewer is configured on this host, so no admin action can be taken.";
  }
  if (status === 403 && code === "stamp_holder_unbound") {
    return "This wallet is not bound to a holder record. A reviewer has to make that binding before a portal exists.";
  }
  if (status === 403) return "This wallet is not on the reviewer list for this issuer.";
  if (status === 404) return detail || "Not found — or not yours.";
  if (status === 400) return detail || "The request was refused as invalid.";
  if (reasons) return `${detail || "Refused"} (${reasons})`;
  return detail ? `${detail}${code ? ` (${code})` : ""}` : `HTTP ${status}`;
}

/** A 401/403 means "no authority", which the pages show as a panel, not an error line. */
export function isDenied(status: number): boolean {
  return status === 401 || status === 403;
}
