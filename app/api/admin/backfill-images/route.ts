import { NextResponse } from "next/server";

import { addDays, today } from "@/lib/dates";
import { imageSubjectsFor, storeFactImages } from "@/lib/facts";
import { isAuthorisedCron } from "@/lib/jobs";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 30;

/** Written back when nothing suits, so the fact is not asked about again. */
const NOTHING_SUITABLE = "(none suitable)";

/**
 * Give pictures to facts written before the briefing carried any.
 *
 * The quiz's picture round is built from facts that went out with a picture, so
 * without this the first weekly quiz after the change would have no picture
 * round at all — every fact in its period predates the feature.
 *
 * By hand, not on a schedule:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     ".../api/admin/backfill-images?days=14&limit=30"
 *
 * Safe to run repeatedly, and designed to be: it only picks up facts with no
 * image_subject, and records the subject even when the picture cannot be
 * fetched, so a subject with no usable image is tried once rather than retried
 * for ever. `remaining` in the response says whether to run it again.
 */
export async function GET(request: Request) {
  if (!isAuthorisedCron(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const days = Number(params.get("days") ?? DEFAULT_DAYS);
  const limit = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const since = addDays(today(), -Math.abs(days));

  const db = createAdminClient();

  const { data: facts, error } = await db
    .from("pqb_facts")
    .select("fact_key, topic, title, key_fact")
    .is("image_subject", null)
    .gte("publish_date", since)
    .order("publish_date", { ascending: false })
    .order("position");
  if (error) throw error;

  const batch = (facts ?? []).slice(0, limit);
  if (batch.length === 0) {
    return NextResponse.json({ job: "backfill-images", since, done: 0, remaining: 0 });
  }

  const subjects = await imageSubjectsFor(batch);

  const withSubjects = batch.map((fact) => ({
    ...fact,
    image_subject: subjects.get(fact.fact_key) ?? "",
  }));
  const images = await storeFactImages(withSubjects);

  // One update each: a fact whose subject has no usable lead image keeps the
  // subject and a null path, which is what stops it being tried again.
  let illustrated = 0;
  for (const fact of withSubjects) {
    const image = images.get(fact.fact_key);
    if (image) illustrated += 1;

    const { error: updateError } = await db
      .from("pqb_facts")
      .update({
        image_subject: fact.image_subject || NOTHING_SUITABLE,
        image_path: image?.imagePath ?? null,
        image_credit: image?.imageCredit ?? null,
      })
      .eq("fact_key", fact.fact_key);
    if (updateError) throw updateError;
  }

  return NextResponse.json({
    job: "backfill-images",
    since,
    done: batch.length,
    illustrated,
    remaining: (facts ?? []).length - batch.length,
  });
}
