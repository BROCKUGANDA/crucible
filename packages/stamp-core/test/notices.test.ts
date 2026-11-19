import { describe, expect, it } from "vitest";
import {
  EXPIRATION_WARNING_DAYS,
  TOKEN_STRUCTURING_NOTICE_DAYS,
  buildNoticeSchedule,
  escalateOverdue,
  outstandingNotices,
} from "../src/notices.js";
import { resolveExpiration } from "../src/expiration.js";
import { zonedDateKey } from "../src/calendar.js";

const NOW = Date.UTC(2026, 2, 1, 12, 0, 0);
const TSE = Date.UTC(2026, 3, 15, 12, 0, 0);
const EXPIRY = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("notice schedule", () => {
  it("requires a token-structuring notice at least 15 days before the event", () => {
    const notices = buildNoticeSchedule({ structuringEventAt: TSE, now: NOW });
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice.noticeType).toBe("TOKEN_STRUCTURING");
    expect(notice.leadDays).toBe(TOKEN_STRUCTURING_NOTICE_DAYS);
    expect(notice.requiredDeliveryAt).toBeLessThanOrEqual(TSE - 15 * 86_400_000);
    expect(notice.status).toBe("SCHEDULED");
  });

  it("requires an expiration watch at least 30 days before expiry", () => {
    const notices = buildNoticeSchedule({ expirationAt: EXPIRY, now: NOW });
    const notice = notices[0]!;
    expect(notice.leadDays).toBe(EXPIRATION_WARNING_DAYS);
    expect(notice.requiredDeliveryAt).toBeLessThanOrEqual(EXPIRY - 30 * 86_400_000);
  });

  it("marks an overdue notice MISSED rather than dropping it", () => {
    const notices = buildNoticeSchedule({ structuringEventAt: TSE, now: Date.UTC(2026, 3, 20) });
    expect(notices[0]!.status).toBe("MISSED");
    expect(outstandingNotices(notices)).toHaveLength(1);
  });

  it("escalates an overdue notice", () => {
    const notices = buildNoticeSchedule({ structuringEventAt: TSE, now: Date.UTC(2026, 3, 20) });
    expect(escalateOverdue(notices)[0]!.status).toBe("ESCALATED");
  });

  it("does not re-issue a delivered notice", () => {
    const notices = buildNoticeSchedule({
      structuringEventAt: TSE,
      now: Date.UTC(2026, 3, 20),
      delivered: [{ id: "n1", noticeType: "TOKEN_STRUCTURING", deliveredAt: NOW }],
    });
    expect(notices[0]!.status).toBe("DELIVERED");
    expect(outstandingNotices(notices)).toHaveLength(0);
  });

  it("creates no notice for an event that has not been scheduled", () => {
    expect(buildNoticeSchedule({ now: NOW })).toEqual([]);
  });
});

describe("expiration precedence", () => {
  const issue = Date.UTC(2025, 0, 1);

  it("prefers the date written into the signed instrument", () => {
    const resolution = resolveExpiration({
      signedExpirationDate: Date.UTC(2027, 0, 1),
      issueDate: issue,
      structuringEventAt: TSE,
      noTokenDecisionAt: Date.UTC(2026, 0, 1),
      now: NOW,
    });
    expect(resolution.basis).toBe("SIGNED_DATE");
    expect(resolution.expired).toBe(false);
  });

  it("falls back to the no-token decision when there is no signed date", () => {
    const resolution = resolveExpiration({
      issueDate: issue,
      structuringEventAt: TSE,
      noTokenDecisionAt: Date.UTC(2026, 0, 1),
      now: NOW,
    });
    expect(resolution.basis).toBe("NO_TOKEN_DECISION");
    expect(resolution.expired).toBe(true);
  });

  it("uses 120 days after the structuring event when there is no decision", () => {
    const resolution = resolveExpiration({ issueDate: issue, structuringEventAt: TSE, now: NOW });
    expect(resolution.basis).toBe("TSE_PLUS_120_DAYS");
    expect(resolution.expired).toBe(false);
    expect(resolution.expiresAt).toBeGreaterThan(TSE);
    expect(resolution.expiresAt).toBeLessThanOrEqual(TSE + 121 * 86_400_000);
  });

  it("uses ten years from issue when no event ever happened", () => {
    const resolution = resolveExpiration({ issueDate: issue, now: NOW });
    expect(resolution.basis).toBe("ISSUE_PLUS_10_YEARS");
    expect(resolution.expired).toBe(false);
  });

  it("ends on the contractual day, in Pacific terms", () => {
    const resolution = resolveExpiration({
      signedExpirationDate: "2027-01-01",
      issueDate: issue,
      now: NOW,
    });
    expect(zonedDateKey(resolution.expiresAt)).toBe("2027-01-01");
  });

  it("reads a signed date given as an instant through its UTC calendar date", () => {
    const resolution = resolveExpiration({
      signedExpirationDate: Date.UTC(2027, 0, 1),
      issueDate: issue,
      now: NOW,
    });
    expect(zonedDateKey(resolution.expiresAt)).toBe("2027-01-01");
  });
});