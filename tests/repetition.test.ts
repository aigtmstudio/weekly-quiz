import { describe, expect, it } from "vitest";

import { INTERVALS, MIN_GAP_DAYS, selectRepeats } from "@/lib/repetition";
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

describe("selectRepeats", () => {
  it("returns nothing when the person has never got anything wrong", () => {
    const rows = [
      performance({ fact_key: "a", times_seen: 5, times_wrong: 0, last_seen_at: daysAgo(30) }),
      performance({ fact_key: "b", times_seen: 3, times_wrong: 0, last_seen_at: daysAgo(60) }),
    ];

    expect(selectRepeats(rows, TODAY)).toEqual([]);
  });

  it("returns nothing at all when there is no history", () => {
    expect(selectRepeats([], TODAY)).toEqual([]);
  });

  it("puts the fact wrong more often first", () => {
    const rows = [
      performance({ fact_key: "once", times_seen: 4, times_wrong: 1, last_seen_at: daysAgo(30) }),
      performance({ fact_key: "twice", times_seen: 4, times_wrong: 2, last_seen_at: daysAgo(30) }),
    ];

    expect(selectRepeats(rows, TODAY)).toEqual(["twice", "once"]);
  });

  it("does not resurface a fact seen yesterday", () => {
    const rows = [performance({ fact_key: "fresh", last_seen_at: daysAgo(1) })];

    expect(selectRepeats(rows, TODAY)).toEqual([]);
  });

  it("resurfaces a newly wrong fact once the minimum gap has passed", () => {
    const rows = [performance({ fact_key: "fresh", last_seen_at: daysAgo(MIN_GAP_DAYS) })];

    expect(selectRepeats(rows, TODAY)).toEqual(["fresh"]);
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

    expect(selectRepeats([wellKnown], TODAY)).toEqual([]);

    const overdue = { ...wellKnown, last_seen_at: daysAgo(INTERVALS.at(-1)!) };
    expect(selectRepeats([overdue], TODAY)).toEqual(["settled"]);
  });

  it("breaks a tie in favour of the least recently seen", () => {
    const rows = [
      performance({ fact_key: "recent", last_seen_at: daysAgo(5) }),
      performance({ fact_key: "stale", last_seen_at: daysAgo(40) }),
    ];

    expect(selectRepeats(rows, TODAY)).toEqual(["stale", "recent"]);
  });

  it("never returns more than the limit", () => {
    const rows = ["a", "b", "c", "d"].map((fact_key) =>
      performance({ fact_key, last_seen_at: daysAgo(40) }),
    );

    expect(selectRepeats(rows, TODAY)).toHaveLength(2);
    expect(selectRepeats(rows, TODAY, 1)).toHaveLength(1);
  });
});
