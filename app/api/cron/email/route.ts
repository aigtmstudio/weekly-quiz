import { NextResponse } from "next/server";

import { londonHour, today } from "@/lib/dates";
import { SEND_HOUR, dispatchEmail } from "@/lib/email/dispatch";
import { isAuthorisedCron, runOnce } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorisedCron(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const date = today();

  // Vercel crons are UTC-only, so 6am London is 05:00 UTC in summer and 06:00
  // in winter. Both are scheduled; whichever fires too early bails out here.
  //
  // Deliberately returns before runOnce, so no job_runs row is written and the
  // later cron is free to do the work. Recording a skip as success would mean
  // no email at all for half the year.
  const hour = londonHour();
  if (hour < SEND_HOUR) {
    return NextResponse.json({
      job: "email",
      date,
      status: "too early",
      londonHour: hour,
      sendHour: SEND_HOUR,
    });
  }

  try {
    const result = await runOnce("email", date, async () => {
      const summary = await dispatchEmail(date);
      const counts = `${summary.daily} daily, ${summary.weekly} weekly, ${summary.monthly} monthly`;
      if (summary.failures.length) {
        // Recorded, but not thrown: the sends that worked still count, and
        // pqb_email_log has released the failed claims for the next run.
        return `${counts}; failures: ${summary.failures.join("; ")}`;
      }
      return counts;
    });

    return NextResponse.json({ job: "email", date, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("email cron failed", error);
    return NextResponse.json({ job: "email", date, error: message }, { status: 500 });
  }
}
