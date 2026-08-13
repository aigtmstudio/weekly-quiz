import Link from "next/link";

import { FactList } from "@/components/fact-card";
import { addDays, formatLong, today } from "@/lib/dates";
import { repeatsForUser } from "@/lib/repetition";
import { createClient } from "@/lib/supabase/server";
import type { Fact, Quiz } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const date = today();

  // Facts are world-readable, so an anonymous visitor sees today's briefing.
  const { data: facts } = await supabase
    .from("pqb_facts")
    .select("*")
    .eq("publish_date", date)
    .order("position");

  const { data: quizzes } = await supabase
    .from("pqb_quizzes")
    .select("*")
    .eq("is_current", true)
    .order("cadence");

  const repeats = user ? await repeatsForUser(user.id, date) : [];

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h1 className="font-serif text-3xl">{formatLong(date)}</h1>
        <p className="mt-1 text-sm text-muted">
          <Link href={`/facts/${addDays(date, -1)}`} className="hover:text-foreground">
            ← yesterday
          </Link>
        </p>
      </section>

      {facts && facts.length > 0 ? (
        <FactList facts={facts as Fact[]} />
      ) : (
        <p className="text-muted">
          Today&rsquo;s facts haven&rsquo;t been published yet. They arrive first thing
          each morning.
        </p>
      )}

      {repeats.length > 0 && (
        <section>
          <h2 className="font-serif text-xl">Worth another look</h2>
          <p className="mt-1 mb-4 text-sm text-muted">
            {repeats.length === 1 ? "This one" : "These"} caught you out before.
          </p>
          <FactList facts={repeats} />
        </section>
      )}

      <QuizPrompt quizzes={(quizzes ?? []) as Quiz[]} signedIn={Boolean(user)} />
    </div>
  );
}

function QuizPrompt({ quizzes, signedIn }: { quizzes: Quiz[]; signedIn: boolean }) {
  if (quizzes.length === 0) return null;

  return (
    <section className="rounded-lg border border-line bg-accent-soft p-5">
      <h2 className="font-serif text-xl">Quizzes open</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {quizzes.map((quiz) => (
          <li key={quiz.id}>
            {signedIn ? (
              <Link href={`/quiz/${quiz.id}`} className="text-accent underline">
                Take the {quiz.cadence} quiz
              </Link>
            ) : (
              <span>The {quiz.cadence} quiz is open</span>
            )}
          </li>
        ))}
      </ul>
      {!signedIn && (
        <p className="mt-3 text-sm text-muted">
          <Link href="/login" className="text-accent underline">
            Sign in
          </Link>{" "}
          to take a quiz — scores are kept per person.
        </p>
      )}
    </section>
  );
}
