import { NextResponse } from "next/server";

import { londonHour, today } from "@/lib/dates";
import { SEND_HOURS, dispatchEmail, type EmailKind } from "@/lib/email/dispatch";
import { isAuthorisedCron, runOnce, type JobResult } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Two waves a day: the briefing at 6am London, quizzes at 8am.
 *
 * Vercel crons are UTC-only, so each London hour is two UTC hours depending on
 * the season — 6am is 05:00 UTC under BST and 06:00 under GMT, 8am is 07:00 and
 * 08:00. `0 5,6,7,8 * * *` covers all four; each firing sends only what its
 * hour has reached and nothing before it.
 *
 * The guard is per wave, not per day. A single `email` job key would mean the
 * 6am briefing marked the whole day done and the 8am quiz never went out —
 * which is exactly the shape of bug that makes an email silently stop.
 */
const WAVES: Array<{ kind: EmailKind; job: string }> = [
  { kind: "daily", job: "email-daily" },
  { kind: "quiz", job: "email-quiz" },
];

export async function GET(request: Request) {
  if (!isAuthorisedCron(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const date = today();
  const hour = londonHour();

  // Deliberately returns before runOnce, so no job_runs row is written for a
  // wave that has not come round yet and the later cron is still free to do the
  // work. Recording a skip as success would mean no email at all.
  const dueNow = WAVES.filter((wave) => hour >= SEND_HOURS[wave.kind]);
  if (dueNow.length === 0) {
    return NextResponse.json({
      job: "email",
      date,
      status: "too early",
      londonHour: hour,
      nextSendHour: SEND_HOURS.daily,
    });
  }

  const results: Record<string, JobResult> = {};

  try {
    for (const { kind, job } of dueNow) {
      results[kind] = await runOnce(job, date, async () => {
        const summary = await dispatchEmail(date, [kind]);
        const counts = `${summary.daily} daily, ${summary.weekly} weekly, ${summary.monthly} monthly`;
        if (summary.failures.length) {
          // Recorded, but not thrown: the sends that worked still count, and
          // pqb_email_log has released the failed claims for the next run.
          return `${counts}; failures: ${summary.failures.join("; ")}`;
        }
        return counts;
      });
    }

    return NextResponse.json({ job: "email", date, londonHour: hour, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("email cron failed", error);
    return NextResponse.json(
      { job: "email", date, londonHour: hour, results, error: message },
      { status: 500 },
    );
  }
}
