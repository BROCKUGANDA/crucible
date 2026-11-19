/**
 * @file notices.ts — contractual notices: what is owed, when, and whether it went.
 *
 * The template requires a notice package before the token structuring event
 * (the blueprint names at least 15 days), and an expiration watch that fires at
 * least 30 days before the relevant Expiration Date. Both are obligations with
 * dates, so they are computed rather than remembered:
 *
 *   - `requiredDeliveryAt` is the Pacific-cutoff business day before the
 *     deadline, because a notice that lands on the deadline day is not a
 *     notice given "at least N days before".
 *   - A notice that was due and has no delivery evidence is `MISSED`, and a
 *     missed notice escalates. It does not quietly disappear, and it is not
 *     silently marked delivered because a mail provider returned 200.
 */

import { PACIFIC_TIMEZONE, addBusinessDays, pacificCutoff } from "./calendar.js";

export const TOKEN_STRUCTURING_NOTICE_DAYS = 15;
export const EXPIRATION_WARNING_DAYS = 30;

export type NoticeType =
  | "TOKEN_STRUCTURING"
  | "EXPIRATION"
  | "DELIVERY"
  | "AMENDMENT"
  | "ASSIGNMENT"
  | "DISSOLUTION";

export type NoticeStatus = "SCHEDULED" | "DUE" | "SENT" | "DELIVERED" | "MISSED" | "ESCALATED";

export interface NoticeRequirement {
  id: string;
  noticeType: NoticeType;
  /** The event the notice is about. */
  subjectAt: number;
  /** How many days before `subjectAt` the notice must be delivered. */
  leadDays: number;
  /** The contractual deadline for delivery. */
  requiredDeliveryAt: number;
  /** The contractual timezone the deadline is expressed in. */
  timeZone: string;
  status: NoticeStatus;
  deliveredAt: number | null;
  deliveryEvidenceUri: string | null;
  /** Why the notice is in its state, in words an operator can act on. */
  reason: string;
}

export interface NoticeScheduleInput {
  /** The token structuring event, if it is scheduled or has happened. */
  structuringEventAt?: number | null;
  /** The instrument's expiration, if it has one. */
  expirationAt?: number | null;
  /** Notices already delivered, so the schedule does not re-issue them. */
  delivered?: readonly { id: string; noticeType: NoticeType; deliveredAt: number }[];
  now?: number;
  timeZone?: string;
  holidays?: readonly string[];
}

function requirement(
  id: string,
  noticeType: NoticeType,
  subjectAt: number,
  leadDays: number,
  now: number,
  timeZone: string,
  holidays: readonly string[],
  delivered: readonly { id: string; noticeType: NoticeType; deliveredAt: number }[],
): NoticeRequirement {
  // Deliver "at least N days before": the deadline is the business day N
  // calendar days before the subject, snapped to the contractual cutoff.
  const target = addBusinessDays(subjectAt, -leadDays, { timeZone, holidays });
  const requiredDeliveryAt = pacificCutoff(target, { timeZone, holidays });
  const already = delivered.find((d) => d.noticeType === noticeType);
  let status: NoticeStatus;
  let reason: string;
  if (already) {
    status = "DELIVERED";
    reason = `delivered at ${new Date(already.deliveredAt).toISOString()}`;
  } else if (now > requiredDeliveryAt) {
    status = "MISSED";
    reason = `was due ${new Date(requiredDeliveryAt).toISOString()} and has no delivery evidence`;
  } else if (now >= requiredDeliveryAt - 86_400_000) {
    status = "DUE";
    reason = `due within 24 hours (${new Date(requiredDeliveryAt).toISOString()})`;
  } else {
    status = "SCHEDULED";
    reason = `scheduled for ${new Date(requiredDeliveryAt).toISOString()}`;
  }
  return {
    id,
    noticeType,
    subjectAt,
    leadDays,
    requiredDeliveryAt,
    timeZone,
    status,
    deliveredAt: already?.deliveredAt ?? null,
    deliveryEvidenceUri: null,
    reason,
  };
}

/**
 * Build the notice schedule for an issuer.
 *
 * Only the notices the known facts support appear. A notice about a
 * structuring event that has not been scheduled is not "overdue"; it does not
 * exist yet.
 */
export function buildNoticeSchedule(input: NoticeScheduleInput): NoticeRequirement[] {
  const now = input.now ?? Date.now();
  const timeZone = input.timeZone ?? PACIFIC_TIMEZONE;
  const holidays = input.holidays ?? [];
  const delivered = input.delivered ?? [];
  const out: NoticeRequirement[] = [];

  if (input.structuringEventAt !== undefined && input.structuringEventAt !== null) {
    out.push(
      requirement(
        "notice-token-structuring",
        "TOKEN_STRUCTURING",
        input.structuringEventAt,
        TOKEN_STRUCTURING_NOTICE_DAYS,
        now,
        timeZone,
        holidays,
        delivered,
      ),
    );
  }
  if (input.expirationAt !== undefined && input.expirationAt !== null) {
    out.push(
      requirement(
        "notice-expiration",
        "EXPIRATION",
        input.expirationAt,
        EXPIRATION_WARNING_DAYS,
        now,
        timeZone,
        holidays,
        delivered,
      ),
    );
  }
  return out;
}

/**
 * Escalate the overdue notices.
 *
 * Escalation is not the same as failure: the notice is still owed, and an
 * operator has to see it until it is delivered with evidence.
 */
export function escalateOverdue(notices: readonly NoticeRequirement[]): NoticeRequirement[] {
  return notices.map((n) =>
    n.status === "MISSED" ? { ...n, status: "ESCALATED" as NoticeStatus } : n,
  );
}

/** The notices that are owed and not yet discharged. */
export function outstandingNotices(notices: readonly NoticeRequirement[]): NoticeRequirement[] {
  return notices.filter((n) => n.status !== "DELIVERED");
}