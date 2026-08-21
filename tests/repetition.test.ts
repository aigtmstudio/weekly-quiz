import { describe, expect, it } from "vitest";

import {
  INTERVALS,
  MIN_GAP_DAYS,
  RESURFACE_COOLDOWN_DAYS,
  selectRepeats,
} from "@/lib/repetition";
import type { FactPerformance } from "@/lib/types";

/**
 * The repetition scheduler is the highest-value thing to test here: the logic
 * is fiddly and, when it goes wrong, it goes wrong silently — nobody notices a
 * fact that quietly stopped coming back.
 */

const TODAY = "2026-08-10";

function performance(overrides: Partial<FactPerformance> & { fact_key: string }): FactPerformance {
  return {
    user_id: "user-1",
    times_seen: 1,
    times_wrong: 1,
    last_seen_at: null,
    last_wrong_at: null,
    ...overrides,
  };
}

/** `days` days before TODAY, at midday, so timezone can't shift the date. */
function daysAgo(days: number): string {
  const date = new Date(`${TODAY}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

/** The same, as a plain date — what pqb_resurfacings.shown_on holds. */
function dateDaysAgo(days: number): string {
  return daysAgo(days).slice(0, 10);
}

describe("selectRepeats", () => {
  it("returns nothing when the person has never got anything wrong", () => {
    const rows = [
      performance({ fact_key: "a", times_seen: 5, times_wrong: 0, last_seen_at: daysAgo(30) }),
      performance({ fact_key: "b", times_seen: 3, times_wrong: 0, last_seen_at: daysAgo(60) }),
    ];

    expect(selectRepeats(rows, { date: TODAY })).toEqual([]);
  });

  it("returns nothing at all when there is no history", () => {
    expect(selectRepeats([], { date: TODAY })).toEqual([]);
  });

  it("puts the fact wrong more often first", () => {
    const rows = [
      performance({ fact_key: "once", times_seen: 4, times_wrong: 1, last_seen_at: daysAgo(30) }),
      performance({ fact_key: "twice", times_seen: 4, times_wrong: 2, last_seen_at: daysAgo(30) }),
    ];

    expect(selectRepeats(rows, { date: TODAY })).toEqual(["twice", "once"]);
  });

  it("does not resurface a fact seen yesterday", () => {
    const rows = [performance({ fact_key: "fresh", last_seen_at: daysAgo(1) })];

    expect(selectRepeats(rows, { date: TODAY })).toEqual([]);
  });

  it("resurfaces a newly wrong fact once the minimum gap has passed", () => {
    const rows = [performance({ fact_key: "fresh", last_seen_at: daysAgo(MIN_GAP_DAYS) })];

    expect(selectRepeats(rows, { date: TODAY })).toEqual(["fresh"]);
  });

  it("expands the gap as the fact is recalled correctly", () => {
    // Wrong once, then right three times: due on the longest interval, not the
    // shortest. Seen a week ago is not yet enough.
    const wellKnown = performance({
      fact_key: "settled",
      times_seen: 4,
      times_wrong: 1,
      last_seen_at: daysAgo(7),
    });

    expect(selectRepeats([wellKnown], { date: TODAY })).toEqual([]);

    const overdue = { ...wellKnown, last_seen_at: daysAgo(INTERVALS.at(-1)!) };
    expect(selectRepeats([overdue], { date: TODAY })).toEqual(["settled"]);
  });

  it("breaks a tie in favour of the least recently seen", () => {
    const rows = [
      performance({ fact_key: "recent", last_seen_at: daysAgo(5) }),
      performance({ fact_key: "stale", last_seen_at: daysAgo(40) }),
    ];

    expect(selectRepeats(rows, { date: TODAY })).toEqual(["stale", "recent"]);
  });

  it("never returns more than the limit", () => {
    const rows = ["a", "b", "c", "d"].map((fact_key) =>
      performance({ fact_key, last_seen_at: daysAgo(40) }),
    );

    expect(selectRepeats(rows, { date: TODAY })).toHaveLength(2);
    expect(selectRepeats(rows, { date: TODAY, limit: 1 })).toHaveLength(1);
  });
});

/**
 * The bug this section exists for: every fact wrong in the same quiz shares an
 * identical last_seen_at, so ranking on that alone produced a byte-for-byte
 * identical order every morning. The same two facts came back all week while
 * nine others waited. Showing a fact has to change its ranking.
 */
describe("rotation", () => {
  const wrongInTheSameQuiz = ["a", "b", "c", "d", "e", "f"].map((fact_key) =>
    performance({ fact_key, last_seen_at: daysAgo(4) }),
  );

  it("works through the backlog instead of repeating the same two facts", () => {
    const shown = new Map<string, string>();
    const seen = new Set<string>();

    // Three mornings in a row, recording what each one resurfaced.
    for (let day = 0; day < 3; day++) {
      const date = dateDaysAgo(-day);
      const picked = selectRepeats(wrongInTheSameQuiz, { date, lastShown: shown });

      expect(picked).toHaveLength(2);
      for (const key of picked) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        shown.set(key, date);
      }
    }

    // All six, rather than the same two over and over.
    expect(seen.size).toBe(wrongInTheSameQuiz.length);

    // Only then does it come back round, and to the pair that has waited
    // longest — the ones from the first morning.
    expect(selectRepeats(wrongInTheSameQuiz, { date: dateDaysAgo(-3), lastShown: shown })).toEqual(
      ["a", "b"],
    );
  });

  it("stands a fact down for a few days once it has been shown", () => {
    const lastShown = new Map([["a", dateDaysAgo(RESURFACE_COOLDOWN_DAYS - 1)]]);

    expect(selectRepeats(wrongInTheSameQuiz, { date: TODAY, lastShown })).not.toContain("a");
  });

  it("lets it come back round once the cooldown has passed", () => {
    const lastShown = new Map(
      wrongInTheSameQuiz.map((row) => [row.fact_key, dateDaysAgo(RESURFACE_COOLDOWN_DAYS)]),
    );
    const picked = selectRepeats(wrongInTheSameQuiz, { date: TODAY, lastShown });

    expect(picked).toHaveLength(2);
  });

  it("takes the one that has waited longest, not the one wrong most often", () => {
    const rows = [
      performance({ fact_key: "waiting", times_wrong: 1, last_seen_at: daysAgo(10) }),
      performance({ fact_key: "worst", times_wrong: 5, last_seen_at: daysAgo(10) }),
    ];
    const lastShown = new Map([["worst", dateDaysAgo(4)]]);

    expect(selectRepeats(rows, { date: TODAY, lastShown, limit: 1 })).toEqual(["waiting"]);
  });
});
