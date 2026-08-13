import { timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { JobOutcome } from "@/lib/types";

/**
 * Cron plumbing: authorisation, and the `pqb_job_runs` idempotency guard that
 * makes a retried invocation safe.
 */

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations.
 * Requiring it means the routes aren't publicly triggerable, and the same
 * header works for triggering them by hand with curl.
 */
export function isAuthorisedCron(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  return constantTimeEquals(token, serverEnv.cronSecret);
}

export type JobResult =
  | { status: "ok"; summary: string }
  | { status: "skipped"; summary: string };

/**
 * Run `work` at most once per (job, period_key).
 *
 * A second invocation for the same period returns `skipped` without doing
 * anything. A previous run that errored or died mid-flight is retried — only a
 * recorded success blocks a re-run.
 */
export async function runOnce(
  job: string,
  periodKey: string,
  work: () => Promise<string>,
): Promise<JobResult> {
  const db = createAdminClient();

  const claim = await db
    .from("pqb_job_runs")
    .insert({ job, period_key: periodKey, outcome: "running" })
    .select("id")
    .single();

  let runId = claim.data?.id;

  if (claim.error) {
    // 23505 = unique violation: this period has been attempted before.
    if (claim.error.code !== "23505") throw claim.error;

    const existing = await db
      .from("pqb_job_runs")
      .select("id, outcome")
      .eq("job", job)
      .eq("period_key", periodKey)
      .single();

    if (existing.error) throw existing.error;

    if (existing.data.outcome === "ok") {
      return { status: "skipped", summary: `${job} already completed for ${periodKey}` };
    }

    // Previous attempt failed or never finished — take it over and retry.
    runId = existing.data.id;
    const retake = await db
      .from("pqb_job_runs")
      .update({
        outcome: "running" satisfies JobOutcome,
        started_at: new Date().toISOString(),
        finished_at: null,
        summary: null,
      })
      .eq("id", runId);
    if (retake.error) throw retake.error;
  }

  try {
    const summary = await work();
    await db
      .from("pqb_job_runs")
      .update({
        outcome: "ok" satisfies JobOutcome,
        finished_at: new Date().toISOString(),
        summary,
      })
      .eq("id", runId!);
    return { status: "ok", summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .from("pqb_job_runs")
      .update({
        outcome: "error" satisfies JobOutcome,
        finished_at: new Date().toISOString(),
        summary: message.slice(0, 2000),
      })
      .eq("id", runId!);
    throw error;
  }
}
