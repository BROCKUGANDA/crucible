import { describe, expect, it } from "vitest";
import {
  PACIFIC_TIMEZONE,
  addBusinessDays,
  businessDaysBetween,
  isBusinessDay,
  pacificCutoff,
  timeZoneOffsetMs,
  zonedDateKey,
  zonedMidnightUtc,
  zonedParts,
} from "../src/calendar.js";

describe("zoned midnight", () => {
  it("resolves Pacific midnight to the right UTC instant in winter and summer", () => {
    // PST (UTC-8) and PDT (UTC-7) are different instants for the same wall time.
    expect(new Date(zonedMidnightUtc(2026, 1, 15, PACIFIC_TIMEZONE)).toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
    expect(new Date(zonedMidnightUtc(2026, 7, 15, PACIFIC_TIMEZONE)).toISOString()).toBe(
      "2026-07-15T07:00:00.000Z",
    );
  });

  it("reports the zone offset", () => {
    expect(timeZoneOffsetMs(Date.UTC(2026, 0, 15))).toBe(-8 * 3600_000);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 15))).toBe(-7 * 3600_000);
  });

  it("round-trips the date key", () => {
    const instant = zonedMidnightUtc(2026, 3, 9, PACIFIC_TIMEZONE);
    expect(zonedDateKey(instant, PACIFIC_TIMEZONE)).toBe("2026-03-09");
  });
});

describe("business days", () => {
  const friday = zonedMidnightUtc(2026, 1, 9, PACIFIC_TIMEZONE); // 2026-01-09 is a Friday
  const saturday = zonedMidnightUtc(2026, 1, 10, PACIFIC_TIMEZONE);
  const monday = zonedMidnightUtc(2026, 1, 12, PACIFIC_TIMEZONE);

  it("excludes weekends", () => {
    expect(isBusinessDay(friday)).toBe(true);
    expect(isBusinessDay(saturday)).toBe(false);
    expect(isBusinessDay(monday)).toBe(true);
  });

  it("excludes the holidays the caller passes", () => {
    expect(isBusinessDay(friday, { holidays: ["2026-01-09"] })).toBe(false);
  });

  it("adds business days across a weekend", () => {
    expect(zonedDateKey(addBusinessDays(friday, 1), PACIFIC_TIMEZONE)).toBe("2026-01-12");
    expect(zonedDateKey(addBusinessDays(monday, -1), PACIFIC_TIMEZONE)).toBe("2026-01-09");
  });

  it("counts business days between two instants, excluding the start day", () => {
    expect(businessDaysBetween(friday, monday)).toBe(1);
    expect(businessDaysBetween(monday, friday)).toBe(-1);
    expect(businessDaysBetween(friday, friday)).toBe(0);
  });

  it("refuses a fractional day count", () => {
    expect(() => addBusinessDays(friday, 1.5)).toThrow(/integer/);
  });
});

describe("pacificCutoff", () => {
  it("counts a filing made before the cutoff on the same day", () => {
    const morning = Date.UTC(2026, 0, 9, 20, 0, 0); // 12:00 PT
    expect(zonedDateKey(pacificCutoff(morning), PACIFIC_TIMEZONE)).toBe("2026-01-09");
  });

  it("rolls a late filing to the next business day", () => {
    const evening = Date.UTC(2026, 0, 10, 3, 0, 0); // 19:00 PT on Friday 2026-01-09
    expect(zonedDateKey(pacificCutoff(evening), PACIFIC_TIMEZONE)).toBe("2026-01-12");
  });

  it("rolls a weekend filing to Monday", () => {
    const saturday = Date.UTC(2026, 0, 10, 20, 0, 0);
    expect(zonedDateKey(pacificCutoff(saturday), PACIFIC_TIMEZONE)).toBe("2026-01-12");
  });
});

describe("zonedParts", () => {
  it("reads the wall clock in the zone", () => {
    const p = zonedParts(Date.UTC(2026, 0, 9, 20, 30, 15), PACIFIC_TIMEZONE);
    expect(p.year).toBe(2026);
    expect(p.month).toBe(1);
    expect(p.day).toBe(9);
    expect(p.hour).toBe(12);
    expect(p.minute).toBe(30);
    expect(p.second).toBe(15);
  });
});