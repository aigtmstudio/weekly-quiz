import { NextResponse } from "next/server";

import { isFirstOfMonth, isMonday, monthKey, today, weekKey } from "@/lib/dates";
import { isAuthorisedCron, runOnce, type JobResult } from "@/lib/jobs";
import { publishQuiz, SPEC } from "@/lib/quiz";
import type { Cadence } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs every day and decides for itself whether anything is due: a weekly quiz
 * on Mondays, a monthly quiz on the 1st. On the 1st of a month that falls on a
 * Monday, both.
 */
export async function GET(request: Request) {
  if (!isAuthorisedCron(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const date = today();

  const due: Array<{ cadence: Cadence; periodKey: string }> = [];
  if (isMonday(date)) due.push({ cadence: "weekly", periodKey: weekKey(date) });
  if (isFirstOfMonth(date)) due.push({ cadence: "monthly", periodKey: monthKey(date) });

  // ?force=weekly|monthly builds one now, whatever day it is. Without this the
  // quiz path can't be exercised until a Monday, which is a long time to wait
  // to find out it doesn't work. Still behind CRON_SECRET, and still idempotent
  // for its period — forcing twice in one week does nothing the second time.
  const forced = new URL(request.url).searchParams.get("force");
  if (forced === "weekly" || forced === "monthly") {
    const periodKey = forced === "weekly" ? weekKey(date) : monthKey(date);
    if (!due.some((entry) => entry.cadence === forced)) {
      due.push({ cadence: forced, periodKey });
    }
  }

  if (due.length === 0) {
    return NextResponse.json({ job: "quizzes", date, status: "nothing due" });
  }

  const results: Record<string, JobResult> = {};

  try {
    for (const { cadence, periodKey } of due) {
      results[cadence] = await runOnce(`quiz-${cadence}`, periodKey, async () => {
        const published = await publishQuiz(cadence, date);
        if (!published) return `not enough facts for a ${cadence} quiz`;

        const notes = [
          `${published.questionCount} questions`,
          `${published.pictureCount} pictures`,
        ];
        if (published.pictureCount < SPEC[cadence].pictureCount) {
          notes.push(
            `short picture round — only ${published.illustratedFacts} facts in the period had an image`,
          );
        }
        return notes.join(", ");
      });
    }

    return NextResponse.json({ job: "quizzes", date, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("quizzes cron failed", error);
    return NextResponse.json(
      { job: "quizzes", date, results, error: message },
      { status: 500 },
    );
  }
}
