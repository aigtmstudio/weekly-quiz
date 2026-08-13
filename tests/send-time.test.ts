import { describe, expect, it } from "vitest";

import { londonHour } from "@/lib/dates";
import { SEND_HOUR } from "@/lib/email/dispatch";

/**
 * The email is meant to arrive at 6am London. Vercel crons are UTC-only, so
 * that hour moves relative to the schedule twice a year. The cron fires at both
 * 05:00 and 06:00 UTC (`0 5,6 * * *`) and the route drops whichever is too early.
 *
 * These tests pin the behaviour on both sides of the clock change, because the
 * failure is silent and seasonal: you would not notice until late October, and
 * then only by being emailed an hour early every morning.
 */

/** The hours `0 5,6 * * *` fires at. Keep in step with vercel.json. */
const CRON_HOURS_UTC = [5, 6];

/** What the route decides for a given moment. */
function wouldSend(utc: string): boolean {
  return londonHour(new Date(utc)) >= SEND_HOUR;
}

/** The first booked cron of the day that actually sends, in London time. */
function firstSendHour(date: string): number | null {
  for (const hour of CRON_HOURS_UTC) {
    const at = `${date}T${String(hour).padStart(2, "0")}:00:00Z`;
    if (wouldSend(at)) return londonHour(new Date(at));
  }
  return null;
}

describe("londonHour", () => {
  it("is an hour ahead of UTC during British Summer Time", () => {
    expect(londonHour(new Date("2026-08-12T05:00:00Z"))).toBe(6);
  });

  it("matches UTC in winter", () => {
    expect(londonHour(new Date("2026-12-12T05:00:00Z"))).toBe(5);
  });

  it("tracks the spring forward", () => {
    // BST begins 29 March 2026 at 01:00 UTC.
    expect(londonHour(new Date("2026-03-29T00:30:00Z"))).toBe(0);
    expect(londonHour(new Date("2026-03-29T01:30:00Z"))).toBe(2);
  });
});

describe("the 6am send survives the clock change", () => {
  it("sends at 6am in summer", () => {
    expect(firstSendHour("2026-08-12")).toBe(SEND_HOUR);
  });

  it("sends at 6am in winter", () => {
    expect(firstSendHour("2026-12-12")).toBe(SEND_HOUR);
  });

  it("sends at 6am either side of the October clock change", () => {
    // BST ends 25 October 2026.
    expect(firstSendHour("2026-10-24")).toBe(SEND_HOUR);
    expect(firstSendHour("2026-10-26")).toBe(SEND_HOUR);
  });

  it("sends at 6am either side of the March clock change", () => {
    expect(firstSendHour("2026-03-28")).toBe(SEND_HOUR);
    expect(firstSendHour("2026-03-30")).toBe(SEND_HOUR);
  });

  it("never sends before 6am on any day of the year", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    for (let day = 0; day < 365; day++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + day);
      const date = d.toISOString().slice(0, 10);
      const hour = firstSendHour(date);
      expect(hour, `no send booked on ${date}`).not.toBeNull();
      expect(hour, `sent too early on ${date}`).toBeGreaterThanOrEqual(SEND_HOUR);
    }
  });

  it("drops the early cron in winter rather than emailing at 5am", () => {
    expect(wouldSend("2026-12-12T05:00:00Z")).toBe(false);
    expect(wouldSend("2026-12-12T06:00:00Z")).toBe(true);
  });

  it("lets the early cron through in summer, so the later one is a no-op", () => {
    expect(wouldSend("2026-08-12T05:00:00Z")).toBe(true);
  });
});
