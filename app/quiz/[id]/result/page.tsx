import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/quiz/${id}/result`);

  const { data: attempt } = await supabase
    .from("pqb_attempts")
    .select("id, submitted_at, score, total")
    .eq("user_id", user.id)
    .eq("quiz_id", id)
    .maybeSingle();

  // Answers are released only once this person has submitted. Somebody else
  // finishing the same quiz does nothing here.
  if (!attempt?.submitted_at) redirect(`/quiz/${id}`);

  const db = createAdminClient();

  const [{ data: questions }, { data: answers }] = await Promise.all([
    db
      .from("pqb_questions")
      .select("id, prompt, correct_answer, explanation, image_path, position")
      .eq("quiz_id", id)
      .order("position"),
    db.from("pqb_answers").select("question_id, response, is_correct").eq("attempt_id", attempt.id),
  ]);

  if (!questions) notFound();

  const byQuestion = new Map((answers ?? []).map((a) => [a.question_id, a]));

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-serif text-3xl">
          {attempt.score} out of {attempt.total}
        </h1>
        <p className="mt-1 text-sm text-muted">
          <Link href="/history" className="hover:text-foreground">
            See how that compares to your other attempts →
          </Link>
        </p>
      </header>

      <ol className="flex flex-col gap-4">
        {questions.map((question, index) => {
          const answer = byQuestion.get(question.id);
          const correct = answer?.is_correct ?? false;
          return (
            <li
              key={question.id}
              className="rounded-lg border border-line bg-surface p-5"
            >
              <p className="text-xs uppercase tracking-widest text-muted">
                {index + 1} ·{" "}
                <span className={correct ? "text-correct" : "text-wrong"}>
                  {correct ? "Correct" : "Wrong"}
                </span>
              </p>
              <p className="mt-2 font-serif text-lg leading-snug">{question.prompt}</p>
              <p className="mt-3 text-sm">
                <span className="text-muted">You said: </span>
                {answer?.response ? answer.response : <em>nothing</em>}
              </p>
              {!correct && (
                <p className="mt-1 text-sm">
                  <span className="text-muted">Answer: </span>
                  {question.correct_answer}
                </p>
              )}
              {question.explanation && (
                <p className="mt-3 leading-relaxed text-muted">{question.explanation}</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
