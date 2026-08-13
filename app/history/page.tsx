import Link from "next/link";
import { redirect } from "next/navigation";

import { formatShort } from "@/lib/dates";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/history");

  // pqb_fact_performance is server-side only, so this reads through the admin
  // client with the user id pinned explicitly.
  const db = createAdminClient();

  const [{ data: attempts }, { data: performance }, { data: quizzes }] = await Promise.all([
    db
      .from("pqb_attempts")
      .select("id, quiz_id, submitted_at, score, total")
      .eq("user_id", user.id)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false }),
    db.from("pqb_fact_performance").select("*").eq("user_id", user.id),
    db.from("pqb_quizzes").select("id, cadence, period_end"),
  ]);

  const quizById = new Map((quizzes ?? []).map((quiz) => [quiz.id, quiz]));

  const weakKeys = (performance ?? [])
    .filter((row) => row.times_wrong > 0)
    .sort((a, b) => b.times_wrong - a.times_wrong || a.fact_key.localeCompare(b.fact_key));

  const { data: weakFacts } = weakKeys.length
    ? await db
        .from("pqb_facts")
        .select("fact_key, title, topic")
        .in(
          "fact_key",
          weakKeys.slice(0, 20).map((row) => row.fact_key),
        )
    : { data: [] };

  const byKey = new Map((weakFacts ?? []).map((fact) => [fact.fact_key, fact]));

  const topicMisses = new Map<string, number>();
  for (const row of weakKeys) {
    const topic = byKey.get(row.fact_key)?.topic;
    if (!topic) continue;
    topicMisses.set(topic, (topicMisses.get(topic) ?? 0) + row.times_wrong);
  }
  const weakestTopics = [...topicMisses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <div className="flex flex-col gap-10">
      <h1 className="font-serif text-3xl">Your history</h1>

      <section>
        <h2 className="font-serif text-xl">Scores</h2>
        {attempts && attempts.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-2">
            {attempts.map((attempt) => {
              const quiz = quizById.get(attempt.quiz_id);
              return (
                <li
                  key={attempt.id}
                  className="flex items-baseline gap-3 rounded-md border border-line bg-surface px-4 py-3"
                >
                  <span className="capitalize">{quiz?.cadence ?? "quiz"}</span>
                  <span className="text-sm text-muted">
                    to {quiz ? formatShort(quiz.period_end) : "—"}
                  </span>
                  <span className="ml-auto font-serif text-lg">
                    {attempt.score}/{attempt.total}
                  </span>
                  <Link
                    href={`/quiz/${attempt.quiz_id}/result`}
                    className="text-sm text-accent underline"
                  >
                    review
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-muted">No submitted quizzes yet.</p>
        )}
      </section>

      <section>
        <h2 className="font-serif text-xl">What keeps catching you out</h2>
        {weakestTopics.length > 0 ? (
          <>
            <ul className="mt-3 flex flex-wrap gap-2">
              {weakestTopics.map(([topic, misses]) => (
                <li
                  key={topic}
                  className="rounded-full border border-line bg-accent-soft px-3 py-1 text-sm"
                >
                  {topic} · {misses} missed
                </li>
              ))}
            </ul>
            <ul className="mt-4 flex flex-col gap-2">
              {weakKeys.slice(0, 10).map((row) => (
                <li key={row.fact_key} className="text-sm">
                  <span className="text-muted">
                    {row.times_wrong}× wrong of {row.times_seen} —{" "}
                  </span>
                  {byKey.get(row.fact_key)?.title ?? row.fact_key}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-3 text-muted">
            Nothing yet. Facts you get wrong turn up again in your daily email a few
            days later.
          </p>
        )}
      </section>
    </div>
  );
}
