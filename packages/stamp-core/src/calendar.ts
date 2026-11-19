/**
 * @file calendar.ts — Pacific Time cutoffs and the San Francisco business-day calendar.
 *
 * The signed STAMP anchors its delivery/exercise timing on Pacific Time and its
 * business-day definition on San Francisco. Neither is derivable from the host's
 * timezone: a UTC server that computes "the first of the next month" from its own
 * clock puts a release a day early for eight months of the year and a day late
 * for the other four.
 *
 * So the calendar is explicit:
 *
 *   - `zonedMidnightUtc` resolves midnight on a calendar date, in a zone, as an instant.
 *   - `pacificCutoff` resolves an instant to the contractual day it counts as.
 *   - `isBusinessDay` / `addBusinessDays` / `businessDaysBetween` implement the
 *     San Francisco business-day definition (Monday-Friday, minus the holidays
 *     the caller passes — the host has no opinion on a court calendar).
 *
 * Two passes resolve a zoned midnight: guess with the offset at UTC-midnight,
 * then re-resolve with the offset that actually applies at the guessed instant.
 * One extra pass covers every zone whose offset changes at midnight (none in
 * America/Los_Angeles, but the helper is not Pacific-specific).
 */

export const PACIFIC_TIMEZONE = "America/Los_Angeles";

/** The contractual Pacific cutoff: filings at or before 17:00 PT count that day. */
export const DEFAULT_PACIFIC_CUTOFF_HOUR = 17;

const DAY_MS = 86_400_000;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(instant: Date | number, timeZone: string = PACIFIC_TIMEZONE): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(instant));
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = Number(read("hour"));
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    // Intl renders midnight as 24 in some ICU versions; normalise it to 0.
    hour: hour === 24 ? 0 : hour,
    minute: Number(read("minute")),
    second: Number(read("second")),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
export function timeZoneOffsetMs(instant: Date | number, timeZone: string = PACIFIC_TIMEZONE): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second precision so the offset is a whole second.
  return asUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000;
}

/** `YYYY-MM-DD` for an instant in a zone. */
export function zonedDateKey(instant: Date | number, timeZone: string = PACIFIC_TIMEZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year.toString().padStart(4, "0")}-${p.month.toString().padStart(2, "0")}-${p.day
    .toString()
    .padStart(2, "0")}`;
}

/** Day of week in the zone: 0 = Sunday .. 6 = Saturday. */
export function zonedDayOfWeek(instant: Date | number, timeZone: string = PACIFIC_TIMEZONE): number {
  return dayOfWeekFromKey(zonedDateKey(instant, timeZone));
}

/** Day of week from a `YYYY-MM-DD` key. */
export function dayOfWeekFromKey(key: string): number {
  const [y, m, d] = key.split("-").map((x) => Number(x));
  if (!y || !m || !d) throw new Error(`dayOfWeekFromKey: bad key ${key}`);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export interface BusinessCalendarOptions {
  timeZone?: string;
  /** `YYYY-MM-DD` dates that are not business days (a court or city holiday). */
  holidays?: readonly string[];
}

/**
 * A business day: Monday-Friday in the zone and not on the supplied holiday list.
 *
 * The host has no opinion on holidays. The caller passes the calendar the
 * contract means; an empty list means "weekdays only", which is the documented
 * default and never a silent guess at a public calendar.
 */
export function isBusinessDay(instant: Date | number, options: BusinessCalendarOptions = {}): boolean {
  const timeZone = options.timeZone ?? PACIFIC_TIMEZONE;
  const key = zonedDateKey(instant, timeZone);
  const dow = dayOfWeekFromKey(key);
  if (dow === 0 || dow === 6) return false;
  return !(options.holidays ?? []).includes(key);
}

/** Add `n` business days to an instant (n may be negative). */
export function addBusinessDays(
  instant: Date | number,
  n: number,
  options: BusinessCalendarOptions = {},
): number {
  if (!Number.isInteger(n)) throw new Error("addBusinessDays: n must be an integer");
  const timeZone = options.timeZone ?? PACIFIC_TIMEZONE;
  const holidays = options.holidays ?? [];
  const p = zonedParts(instant, timeZone);
  let cursor = zonedMidnightUtc(p.year, p.month, p.day, timeZone);
  let remaining = n;
  const direction = n >= 0 ? 1 : -1;
  // Guard against an infinite walk when every day in range is a holiday.
  let guard = 0;
  while (remaining !== 0) {
    guard += 1;
    if (guard > 100_000) {
      throw new Error("addBusinessDays: no business day found within 100000 days");
    }
    cursor += direction * DAY_MS;
    const key = zonedDateKey(cursor, timeZone);
    const dow = dayOfWeekFromKey(key);
    if (dow !== 0 && dow !== 6 && !holidays.includes(key)) remaining -= direction;
  }
  return cursor;
}

/**
 * Business days between two instants (b - a); negative when `b` precedes `a`.
 *
 * The day `a` lands on is not counted: this is the number of business days
 * between two instants, which is what a deadline that says "within N business
 * days of the Delivery Date" means.
 */
export function businessDaysBetween(
  a: Date | number,
  b: Date | number,
  options: BusinessCalendarOptions = {},
): number {
  const timeZone = options.timeZone ?? PACIFIC_TIMEZONE;
  const holidays = options.holidays ?? [];
  const start = zonedParts(a, timeZone);
  const end = zonedParts(b, timeZone);
  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);
  const sign = endUtc >= startUtc ? 1 : -1;
  let count = 0;
  // Start one day past `a`: the day `a` lands on is not "between" the two.
  for (
    let cursor = startUtc + sign * DAY_MS;
    sign > 0 ? cursor <= endUtc : cursor >= endUtc;
    cursor += sign * DAY_MS
  ) {
    const dow = new Date(cursor).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const key = zonedDateKey(cursor, timeZone);
      if (!holidays.includes(key)) count += sign;
    }
  }
  return count;
}

/**
 * The contractual day an instant counts as.
 *
 * A filing made before the cutoff on a business day counts that day; a late
 * filing, or one made on a non-business day, rolls to the next business day.
 * The returned instant is the start of that business day in the zone.
 */
export function pacificCutoff(
  instant: Date | number,
  options: BusinessCalendarOptions & { cutoffHour?: number } = {},
): number {
  const timeZone = options.timeZone ?? PACIFIC_TIMEZONE;
  const cutoffHour = options.cutoffHour ?? DEFAULT_PACIFIC_CUTOFF_HOUR;
  const holidays = options.holidays ?? [];
  const p = zonedParts(instant, timeZone);
  const midnight = zonedMidnightUtc(p.year, p.month, p.day, timeZone);
  const sameDayIsBusiness = isBusinessDay(midnight, { timeZone, holidays });
  const beforeCutoff = p.hour < cutoffHour;
  if (sameDayIsBusiness && beforeCutoff) return midnight;
  return addBusinessDays(midnight, 1, { timeZone, holidays });
}

/** Midnight in a zone, as an instant. */
export function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string = PACIFIC_TIMEZONE,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = naive - timeZoneOffsetMs(naive, timeZone);
  for (let i = 0; i < 2; i++) {
    const next = naive - timeZoneOffsetMs(instant, timeZone);
    if (next === instant) return instant;
    instant = next;
  }
  return instant;
}