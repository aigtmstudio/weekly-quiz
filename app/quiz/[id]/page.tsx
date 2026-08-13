import { notFound, redirect } from "next/navigation";

import { formatShort } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";
import type { PublicQuestion, Quiz } from "@/lib/types";

import { QuizForm } from "./quiz-form";

export const dynamic = "force-dynamic";

export default async function QuizPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/quiz/${id}`);

  const { data: quiz } = await supabase
    .from("pqb_quizzes")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!quiz) notFound();

  // Already marked — there is one attempt per person per quiz.
  const { data: attempt } = await supabase
    .from("pqb_attempts")
    .select("id, submitted_at")
    .eq("user_id", user.id)
    .eq("quiz_id", id)
    .maybeSingle();
  if (attempt?.submitted_at) redirect(`/quiz/${id}/result`);

  // pqb_questions_public omits correct_answer, accepted_answers and
  // explanation, so none of them reach the browser before submission.
  const { data: questions } = await supabase
    .from("pqb_questions_public")
    .select("*")
    .eq("quiz_id", id)
    .order("position");

  if (!questions || questions.length === 0) notFound();

  const initialResponses: Record<string, string> = {};
  if (attempt) {
    const { data: saved } = await supabase
      .from("pqb_answers")
      .select("question_id, response")
      .eq("attempt_id", attempt.id);
    for (const row of saved ?? []) initialResponses[row.question_id] = row.response;
  }

  const { cadence, period_start, period_end } = quiz as Quiz;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-serif text-3xl capitalize">{cadence} quiz</h1>
        <p className="mt-1 text-sm text-muted">
          Facts from {formatShort(period_start)} to {formatShort(period_end)} ·{" "}
          {questions.length} questions
        </p>
      </header>

      <QuizForm
        quizId={id}
        questions={questions as PublicQuestion[]}
        initialResponses={initialResponses}
      />
    </div>
  );
}
