/**
 * Date helpers. Everything the app schedules is in Europe/London — the crons
 * run in UTC, so the calendar date has to be derived explicitly rather than
 * taken from the server clock.
 */

export const TIMEZONE = "Europe/London";

const ISO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in London, as YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
  return ISO_DATE.format(now);
}

const LONDON_HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  hour: "numeric",
  hour12: false,
});

/**
 * The hour of the day in London, 0-23.
 *
 * Vercel crons are scheduled in UTC with no timezone support, so a job pinned
 * to a fixed UTC hour drifts by one at each clock change. Jobs that care about
 * local time check this instead of trusting the schedule.
 */
export function londonHour(now: Date = new Date()): number {
  return Number(LONDON_HOUR.format(now));
}

/** Parse YYYY-MM-DD as a UTC-midnight Date, so arithmetic stays DST-proof. */
function parse(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** 1 = Monday … 7 = Sunday. */
export function weekday(date: string): number {
  return parse(date).getUTCDay() || 7;
}

export function isMonday(date: string): boolean {
  return weekday(date) === 1;
}

export function isFirstOfMonth(date: string): boolean {
  return date.endsWith("-01");
}

/** The Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, -(weekday(date) - 1));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const d = parse(startOfMonth(date));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return format(d);
}

/** ISO week key, e.g. `2026-W33`. Used as the idempotency key for weekly jobs. */
export function weekKey(date: string): string {
  const d = parse(date);
  // ISO weeks are numbered by the Thursday of the week.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Month key, e.g. `2026-08`. */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

/** e.g. `Monday 10 August 2026`. */
export function formatLong(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parse(date));
}

/** e.g. `10 Aug`. */
export function formatShort(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(parse(date));
}
