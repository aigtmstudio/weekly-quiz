import { describe, expect, it } from "vitest";

import { londonHour } from "@/lib/dates";
import { SEND_HOURS, SEND_HOUR, type EmailKind } from "@/lib/email/dispatch";

/**
 * The briefing is meant to arrive at 6am London and the quizzes at 8am. Vercel
 * crons are UTC-only, so both hours move relative to the schedule twice a year.
 * The cron fires at 05:00, 06:00, 07:00 and 08:00 UTC (`0 5,6,7,8 * * *`) and
 * the route sends only what each firing's London hour has reached.
 *
 * These tests pin the behaviour on both sides of the clock change, because the
 * failure is silent and seasonal: you would not notice until late October, and
 * then only by being emailed an hour early every morning.
 */

/** The hours `0 5,6,7,8 * * *` fires at. Keep in step with vercel.json. */
const CRON_HOURS_UTC = [5, 6, 7, 8];

/** What the route decides for a given moment. */
function wouldSend(utc: string, kind: EmailKind = "daily"): boolean {
  return londonHour(new Date(utc)) >= SEND_HOURS[kind];
}

/** The first booked cron of the day that sends this kind, in London time. */
function firstSendHour(date: string, kind: EmailKind = "daily"): number | null {
  for (const hour of CRON_HOURS_UTC) {
    const at = `${date}T${String(hour).padStart(2, "0")}:00:00Z`;
    if (wouldSend(at, kind)) return londonHour(new Date(at));
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

/**
 * The quiz goes out two hours after the briefing. The trap is that the same
 * cron fires for both: a firing that is late enough for the briefing is not
 * necessarily late enough for the quiz, and one that sends the quiz must not
 * have been the day's only chance to send the briefing.
 */
describe("the 8am quiz send", () => {
  it("waits until 8am, not 6am", () => {
    expect(wouldSend("2026-08-28T05:00:00Z", "quiz")).toBe(false); // 6am BST
    expect(wouldSend("2026-08-28T06:00:00Z", "quiz")).toBe(false); // 7am BST
    expect(wouldSend("2026-08-28T07:00:00Z", "quiz")).toBe(true); // 8am BST
  });

  it("lands at 8am on both sides of the clock change", () => {
    expect(firstSendHour("2026-08-28", "quiz")).toBe(SEND_HOURS.quiz);
    expect(firstSendHour("2026-12-11", "quiz")).toBe(SEND_HOURS.quiz);
    expect(firstSendHour("2026-10-24", "quiz")).toBe(SEND_HOURS.quiz);
    expect(firstSendHour("2026-10-26", "quiz")).toBe(SEND_HOURS.quiz);
  });

  it("books a send for both waves every day of the year", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    for (let day = 0; day < 365; day++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + day);
      const date = d.toISOString().slice(0, 10);

      expect(firstSendHour(date, "daily"), `no briefing booked on ${date}`).toBe(
        SEND_HOURS.daily,
      );
      expect(firstSendHour(date, "quiz"), `no quiz booked on ${date}`).toBe(SEND_HOURS.quiz);
    }
  });

  it("arrives after the briefing, never with it", () => {
    expect(SEND_HOURS.quiz).toBeGreaterThan(SEND_HOURS.daily);
  });
});
