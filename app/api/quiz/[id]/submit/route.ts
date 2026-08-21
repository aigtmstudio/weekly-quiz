import { NextResponse } from "next/server";

import { applyVerdicts, gradeAttempt, needsReview } from "@/lib/grader";
import { markFreeText } from "@/lib/marker";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Body {
  responses?: Record<string, unknown>;
}

/**
 * Grade and record an attempt.
 *
 * Note what this does *not* do: it never touches the quiz row. Two people take
 * the same quiz independently, and one submitting leaves the other's attempt
 * exactly as it was.
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

  const db = createAdminClient();

  const { data: member } = await db
    .from("pqb_members")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) {
    return NextResponse.json({ error: "Not a member" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const responses: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.responses ?? {})) {
    if (typeof value === "string") responses[key] = value;
  }

  const { data: questions, error: questionsError } = await db
    .from("pqb_questions")
    .select("id, prompt, options, correct_answer, accepted_answers, explanation, position")
    .eq("quiz_id", quizId)
    .order("position");
  if (questionsError) throw questionsError;

  if (!questions || questions.length === 0) {
    return NextResponse.json({ error: "No such quiz" }, { status: 404 });
  }

  // One attempt per person per quiz. Claim it, or pick up the existing one.
  const claim = await db
    .from("pqb_attempts")
    .insert({ user_id: user.id, quiz_id: quizId })
    .select("id, submitted_at")
    .single();

  let attempt = claim.data;

  if (claim.error) {
    if (claim.error.code !== "23505") throw claim.error;
    const existing = await db
      .from("pqb_attempts")
      .select("id, submitted_at")
      .eq("user_id", user.id)
      .eq("quiz_id", quizId)
      .single();
    if (existing.error) throw existing.error;
    attempt = existing.data;
  }

  if (!attempt) {
    return NextResponse.json({ error: "Could not start an attempt" }, { status: 500 });
  }

  if (attempt.submitted_at) {
    return NextResponse.json(
      { error: "You have already submitted this quiz" },
      { status: 409 },
    );
  }

  const exact = gradeAttempt(questions, responses);

  // Exact matching can't always mark a typed answer — a name spelled a little
  // differently, or the right idea in different words. Anything it rejected
  // gets read for meaning before the score is final.
  //
  // Multiple choice is excluded: the response is one of the options we gave, so
  // a miss is a miss and there is nothing to interpret.
  const pending = needsReview(exact)
    .map((answer) => {
      const question = questions.find((q) => q.id === answer.question_id)!;
      return { question, response: answer.response };
    })
    .filter(({ question }) => question.options.length === 0)
    .map(({ question, response }) => ({
      question_id: question.id,
      prompt: question.prompt,
      expected: question.correct_answer,
      accepted: question.accepted_answers,
      explanation: question.explanation,
      response,
    }));

  const graded = applyVerdicts(exact, await markFreeText(pending));

  const { error: answersError } = await db.from("pqb_answers").upsert(
    graded.answers.map((answer) => ({
      attempt_id: attempt.id,
      question_id: answer.question_id,
      response: answer.response,
      is_correct: answer.is_correct,
    })),
    { onConflict: "attempt_id,question_id" },
  );
  if (answersError) throw answersError;

  const { error: submitError } = await db
    .from("pqb_attempts")
    .update({
      submitted_at: new Date().toISOString(),
      score: graded.score,
      total: graded.total,
    })
    .eq("id", attempt.id);
  if (submitError) throw submitError;

  // Answers and explanations are released only now, with the result.
  return NextResponse.json({
    score: graded.score,
    total: graded.total,
    results: questions.map((question) => {
      const answer = graded.answers.find((a) => a.question_id === question.id);
      return {
        question_id: question.id,
        prompt: question.prompt,
        response: answer?.response ?? "",
        is_correct: answer?.is_correct ?? false,
        correct_answer: question.correct_answer,
        explanation: question.explanation,
      };
    }),
  });
}
