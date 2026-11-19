/**
 * @file expiration.ts — when an instrument expires, and which rule decides.
 *
 * The template gives an instrument an expiration through one of three routes,
 * and the routes are not interchangeable:
 *
 *   1. A date written into the signed instrument. This is the only route the
 *      parties actually agreed on, so it wins outright.
 *   2. A decision not to launch a token at all. There is nothing to deliver,
 *      so waiting out a date is the wrong answer: the instrument terminates on
 *      the decision.
 *   3. A long-stop measured from the token structuring event (120 days in the
 *      template) or, if no structuring event ever happens, from the issue date
 *      (ten years).
 *
 * The precedence is fixed and recorded on the result, because an expiry that
 * arrives by a route nobody can name is an expiry nobody can defend.
 */

import { PACIFIC_TIMEZONE, zonedMidnightUtc, zonedParts } from "./calendar.js";

export const DAYS_PER_YEAR = 365;
export const TSE_EXPIRY_DAYS = 120;

export type ExpirationBasis =
  | "SIGNED_DATE"
  | "NO_TOKEN_DECISION"
  | "TSE_PLUS_120_DAYS"
  | "ISSUE_PLUS_10_YEARS";

export interface ExpirationInput {
  /**
   * The expiration date written into the signed instrument, if any.
   *
   * A contract states a calendar date, so a `YYYY-MM-DD` string is the honest
   * form. An instant is accepted and read as its *UTC* calendar date, because
   * a date signed as `2027-01-01` means the first of January wherever the
   * document was signed — not the day before it in Pacific terms.
   */
  signedExpirationDate?: number | string | null;
  /** The issue date of the instrument. */
  issueDate: number;
  /** The instant the token structuring event finalised, if any. */
  structuringEventAt?: number | null;
  /** The instant of a decision not to launch a token, if any. */
  noTokenDecisionAt?: number | null;
  /** The instant to evaluate expiry against. Defaults to the wall clock. */
  now?: number;
  timeZone?: string;
}

export interface ExpirationResolution {
  /** The instant the instrument expires (end of the contractual day). */
  expiresAt: number;
  basis: ExpirationBasis;
  /** A human-readable statement of which rule produced the answer. */
  explanation: string;
  /** True when the instrument is already expired at `now`. */
  expired: boolean;
}

/** End of the contractual day, in Pacific terms. */
function endOfDay(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return zonedMidnightUtc(p.year, p.month, p.day + 1, timeZone) - 1;
}

/** The UTC calendar date of an instant, as `YYYY-MM-DD`. */
function utcDateKey(instant: number): string {
  const d = new Date(instant);
  return `${d.getUTCFullYear().toString().padStart(4, "0")}-${(d.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${d.getUTCDate().toString().padStart(2, "0")}`;
}

/** End of the contractual day named by a `YYYY-MM-DD` key, in Pacific terms. */
function endOfDayKey(key: string, timeZone: string): number {
  const [y, m, d] = key.split("-").map((x) => Number(x));
  if (!y || !m || !d) throw new Error(`bad date key: ${key}`);
  return zonedMidnightUtc(y, m, d + 1, timeZone) - 1;
}

export function resolveExpiration(input: ExpirationInput, nowArg?: number): ExpirationResolution {
  const now = nowArg ?? input.now ?? Date.now();
  const timeZone = input.timeZone ?? PACIFIC_TIMEZONE;

  if (input.signedExpirationDate !== undefined && input.signedExpirationDate !== null) {
    const key =
      typeof input.signedExpirationDate === "string"
        ? input.signedExpirationDate
        : utcDateKey(input.signedExpirationDate);
    const expiresAt = endOfDayKey(key, timeZone);
    return {
      expiresAt,
      basis: "SIGNED_DATE",
      explanation: "the signed instrument states its own expiration date, which governs",
      expired: now > expiresAt,
    };
  }

  if (input.noTokenDecisionAt !== undefined && input.noTokenDecisionAt !== null) {
    const expiresAt = endOfDay(input.noTokenDecisionAt, timeZone);
    return {
      expiresAt,
      basis: "NO_TOKEN_DECISION",
      explanation: "the parties decided not to launch a token; the instrument terminates on that decision",
      expired: now > expiresAt,
    };
  }

  if (input.structuringEventAt !== undefined && input.structuringEventAt !== null) {
    const expiresAt = endOfDay(
      input.structuringEventAt + TSE_EXPIRY_DAYS * 86_400_000,
      timeZone,
    );
    return {
      expiresAt,
      basis: "TSE_PLUS_120_DAYS",
      explanation: `no signed date and no no-token decision: ${TSE_EXPIRY_DAYS} days after the token structuring event`,
      expired: now > expiresAt,
    };
  }

  const expiresAt = endOfDay(
    input.issueDate + DAYS_PER_YEAR * 365 * 86_400_000,
    timeZone,
  );
  return {
    expiresAt,
    basis: "ISSUE_PLUS_10_YEARS",
    explanation: "no signed date, no decision and no structuring event: ten years from issue",
    expired: now > expiresAt,
  };
}