import { daysBetween, today } from "@/lib/dates";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Fact, FactPerformance } from "@/lib/types";

/**
 * Personalised repetition.
 *
 * Each person's daily briefing is the day's new facts plus one or two they have
 * previously got wrong. Facts they have never got wrong are not resurfaced —
 * with no history there is nothing to space out, and padding the briefing with
 * things they already know would make it worth less, not more.
 *
 * The scheduler needs two different clocks and it is easy to conflate them:
 *
 *   - `last_seen_at` — when the fact was last *tested*, from an attempt.
 *   - `shown_on`     — when the fact was last *resurfaced* in a briefing.
 *
 * Only the first of those existed originally, which meant showing a fact
 * changed nothing about its ranking. Every fact wrong in the same quiz shared
 * an identical last_seen_at, so the ordering was byte-for-byte identical every
 * morning and the same two facts came back day after day. pqb_resurfacings is
 * the second clock.
 */

/** Expanding gaps, in days, as a fact is recalled correctly more often. */
export const INTERVALS = [1, 3, 7, 21];

/**
 * A fact seen yesterday is not resurfaced today, whatever the interval says.
 * Two days is the floor.
 */
export const MIN_GAP_DAYS = 2;

/** Once resurfaced, a fact steps aside for this long to let others through. */
export const RESURFACE_COOLDOWN_DAYS = 3;

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

export interface SelectOptions {
  date?: string;
  /** fact_key → the last date it appeared in a briefing. */
  lastShown?: ReadonlyMap<string, string>;
  limit?: number;
}

/**
 * Which facts to bring back today. Returns at most `limit` keys, and an empty
 * list when nothing is due.
 *
 * Ordering is rotation-first: whatever has waited longest since it was last
 * shown goes next, so a backlog of wrong answers is worked through rather than
 * the worst two being repeated indefinitely. How often it was missed breaks
 * ties, so a fact wrong twice still outranks one wrong once when neither has
 * been shown.
 */
export function selectRepeats(
  performance: FactPerformance[],
  { date = today(), lastShown = new Map(), limit = MAX_REPEATS }: SelectOptions = {},
): string[] {
  const due = performance
    .filter((row) => row.times_wrong > 0)
    .map((row) => {
      const seen = lastSeenDate(row);
      const shown = lastShown.get(row.fact_key);
      return {
        row,
        elapsed: seen === null ? Infinity : daysBetween(seen, date),
        sinceShown: shown === undefined ? Infinity : daysBetween(shown, date),
      };
    })
    .filter(
      ({ row, elapsed, sinceShown }) =>
        elapsed >= MIN_GAP_DAYS &&
        elapsed >= intervalFor(row) &&
        sinceShown >= RESURFACE_COOLDOWN_DAYS,
    );

  due.sort((a, b) => {
    if (b.sinceShown !== a.sinceShown) return b.sinceShown - a.sinceShown;
    if (b.row.times_wrong !== a.row.times_wrong) {
      return b.row.times_wrong - a.row.times_wrong;
    }
    if (b.elapsed !== a.elapsed) return b.elapsed - a.elapsed;
    return a.row.fact_key.localeCompare(b.row.fact_key);
  });

  return due.slice(0, limit).map(({ row }) => row.fact_key);
}

/**
 * Today's resurfaced facts for one person, ready to render.
 *
 * Get-or-create: the first caller of the day fixes the selection and records
 * it, and everyone after gets the same answer. That is deliberate — the daily
 * email and the website should agree about what "worth another look" means
 * today, whichever the person opens first.
 */
export async function repeatsForUser(
  userId: string,
  date: string = today(),
): Promise<Fact[]> {
  const db = createAdminClient();

  const { data: alreadyChosen, error: chosenError } = await db
    .from("pqb_resurfacings")
    .select("fact_key")
    .eq("user_id", userId)
    .eq("shown_on", date);
  if (chosenError) throw chosenError;

  let keys = (alreadyChosen ?? []).map((row) => row.fact_key);

  if (keys.length === 0) {
    const [{ data: performance, error }, { data: history, error: historyError }] =
      await Promise.all([
        db.from("pqb_fact_performance").select("*").eq("user_id", userId),
        db
          .from("pqb_resurfacings")
          .select("fact_key, shown_on")
          .eq("user_id", userId)
          .order("shown_on", { ascending: false }),
      ]);
    if (error) throw error;
    if (historyError) throw historyError;

    const lastShown = new Map<string, string>();
    for (const row of history ?? []) {
      if (!lastShown.has(row.fact_key)) lastShown.set(row.fact_key, row.shown_on);
    }

    keys = selectRepeats(performance ?? [], { date, lastShown });

    if (keys.length > 0) {
      const { error: recordError } = await db.from("pqb_resurfacings").upsert(
        keys.map((fact_key) => ({ user_id: userId, fact_key, shown_on: date })),
        { onConflict: "user_id,fact_key,shown_on", ignoreDuplicates: true },
      );
      if (recordError) throw recordError;
    }
  }

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
