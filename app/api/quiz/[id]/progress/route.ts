import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Save a half-finished attempt so it can be picked up later, on any device.
 *
 * Runs as the signed-in user rather than the service role: the RLS policies
 * already allow writing your own answers while the attempt is unsubmitted, and
 * refuse once it is. Nothing here grades anything.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: quizId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const responses: Record<string, string> = {};
  try {
    const body = (await request.json()) as { responses?: Record<string, unknown> };
    for (const [key, value] of Object.entries(body.responses ?? {})) {
      if (typeof value === "string") responses[key] = value;
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const { data: attempt } = await supabase
    .from("pqb_attempts")
    .select("id, submitted_at")
    .eq("user_id", user.id)
    .eq("quiz_id", quizId)
    .maybeSingle();

  let attemptId = attempt?.id;

  if (attempt?.submitted_at) {
    return NextResponse.json({ error: "Already submitted" }, { status: 409 });
  }

  if (!attemptId) {
    const { data: created, error } = await supabase
      .from("pqb_attempts")
      .insert({ user_id: user.id, quiz_id: quizId })
      .select("id")
      .single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    attemptId = created.id;
  }

  const rows = Object.entries(responses)
    .filter(([, value]) => value.trim().length > 0)
    .map(([question_id, response]) => ({
      attempt_id: attemptId!,
      question_id,
      response: response.trim(),
    }));

  if (rows.length > 0) {
    const { error } = await supabase
      .from("pqb_answers")
      .upsert(rows, { onConflict: "attempt_id,question_id" });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  }

  return NextResponse.json({ saved: rows.length });
}
