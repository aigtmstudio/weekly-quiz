import { daysBetween, today } from "@/lib/dates";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Fact, FactPerformance } from "@/lib/types";

/**
 * Personalised repetition.
 *
 * Each person's daily email is the five shared facts plus one or two they have
 * previously got wrong. Facts they have never got wrong are not resurfaced —
 * with no history there is nothing to space out, and padding the email with
 * things they already know would make it worth less, not more.
 */

/** Expanding gaps, in days, as a fact is recalled correctly more often. */
export const INTERVALS = [1, 3, 7, 21];

/**
 * A fact seen yesterday is not resurfaced today, whatever the interval says.
 * Two days is the floor.
 */
export const MIN_GAP_DAYS = 2;

export const MAX_REPEATS = 2;

/** How many times this fact has been recalled correctly since it was learned. */
function correctCount(row: FactPerformance): number {
  return Math.max(0, row.times_seen - row.times_wrong);
}

export function intervalFor(row: FactPerformance): number {
  const index = Math.min(correctCount(row), INTERVALS.length - 1);
  return Math.max(INTERVALS[index], MIN_GAP_DAYS);
}

function lastSeenDate(row: FactPerformance): string | null {
  return row.last_seen_at ? today(new Date(row.last_seen_at)) : null;
}

/**
 * Which facts to bring back today, most overdue and most-often-wrong first.
 * Returns at most `limit` fact keys, and an empty list when nothing is due.
 */
export function selectRepeats(
  performance: FactPerformance[],
  date: string = today(),
  limit: number = MAX_REPEATS,
): string[] {
  const due = performance
    .filter((row) => row.times_wrong > 0)
    .map((row) => {
      const seen = lastSeenDate(row);
      return { row, elapsed: seen === null ? Infinity : daysBetween(seen, date) };
    })
    .filter(({ row, elapsed }) => elapsed >= MIN_GAP_DAYS && elapsed >= intervalFor(row));

  due.sort((a, b) => {
    if (b.row.times_wrong !== a.row.times_wrong) {
      return b.row.times_wrong - a.row.times_wrong;
    }
    if (b.elapsed !== a.elapsed) return b.elapsed - a.elapsed;
    return a.row.fact_key.localeCompare(b.row.fact_key);
  });

  return due.slice(0, limit).map(({ row }) => row.fact_key);
}

/** The facts themselves, ready to render alongside the day's new ones. */
export async function repeatsForUser(userId: string, date: string = today()): Promise<Fact[]> {
  const db = createAdminClient();

  const { data: performance, error } = await db
    .from("pqb_fact_performance")
    .select("*")
    .eq("user_id", userId);
  if (error) throw error;

  const keys = selectRepeats(performance ?? [], date);
  if (keys.length === 0) return [];

  const { data: facts, error: factsError } = await db
    .from("pqb_facts")
    .select("*")
    .in("fact_key", keys);
  if (factsError) throw factsError;

  // Preserve the priority order selectRepeats worked out.
  return keys
    .map((key) => (facts ?? []).find((fact) => fact.fact_key === key))
    .filter((fact): fact is Fact => Boolean(fact));
}
