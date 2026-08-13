/**
 * One-off migration of the old tables into the pqb_* schema.
 *
 *   npm run migrate-legacy -- --dry-run     see what would happen
 *   npm run migrate-legacy                  do it
 *   npm run migrate-legacy -- --user <uuid> also bring over the 20 answers
 *
 * This reads ACROSS TWO SUPABASE PROJECTS. The legacy tables (daily_facts,
 * quiz_sessions, quiz_questions, quiz_answers) live in the old shared project
 * and stay there — copying them into the new one would just move the clutter.
 * They are read once, never written, and are a dead archive afterwards.
 *
 *   LEGACY_SUPABASE_URL / LEGACY_SUPABASE_SERVICE_ROLE_KEY   source, read-only
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY     destination
 *
 * Be clear-eyed about the payoff: there are 20 answers in total, all from one
 * session, so the repetition scheduler starts effectively cold either way. The
 * facts and questions are worth keeping; the answers are a nicety.
 *
 * Safe to run twice. Facts are matched on fact_key, quizzes on their period,
 * and nothing is updated in place.
 */

import { createClient } from "@supabase/supabase-js";

import { assignFactKeys } from "../lib/facts";
import type { Cadence, QuestionFormat } from "../lib/types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const legacyUrl = process.env.LEGACY_SUPABASE_URL;
const legacyKey = process.env.LEGACY_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the destination project).",
  );
  process.exit(1);
}
if (!legacyUrl || !legacyKey) {
  console.error(
    "Set LEGACY_SUPABASE_URL and LEGACY_SUPABASE_SERVICE_ROLE_KEY (the old project holding daily_facts).",
  );
  process.exit(1);
}
if (legacyUrl === url) {
  console.error("Source and destination are the same project. That is almost certainly a mistake.");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const userId = args[args.indexOf("--user") + 1] ?? null;
const migrateAnswers = args.includes("--user") && Boolean(userId);

const auth = { persistSession: false, autoRefreshToken: false };

/** Destination: the pqb_* schema. */
const db = createClient(url, key, { auth });

// Source, untyped on purpose: the legacy tables are not in the Database type,
// and adding them would outlive their usefulness by about a day.
const legacyDb = createClient(legacyUrl, legacyKey, { auth });

/** The old question_type values, kept as archive rather than reinterpreted. */
const LEGACY_FORMAT: Record<string, QuestionFormat> = {
  multiple_choice: "legacy_multiple_choice",
  free_text: "legacy_free_text",
  visual: "legacy_visual",
};

function report(step: string, detail: string) {
  console.log(`${dryRun ? "[dry run] " : ""}${step}: ${detail}`);
}

async function migrateFacts() {
  const { data: legacy, error } = await legacyDb
    .from("daily_facts")
    .select("*")
    .order("sent_date")
    .order("created_at");
  if (error) throw error;

  // Six legacy rows share a (sent_date, title): the 6 August batch was
  // published twice, and one day has two different facts under one title.
  // assignFactKeys suffixes the collisions so all 105 survive rather than
  // silently collapsing into each other.
  const keysByDate = new Map<string, string[]>();
  for (const fact of legacy ?? []) {
    const titles = (keysByDate.get(fact.sent_date) ?? []) as string[];
    titles.push(fact.title);
    keysByDate.set(fact.sent_date, titles);
  }
  for (const [date, titles] of keysByDate) {
    keysByDate.set(date, assignFactKeys(titles, date));
  }

  const byDate = new Map<string, number>();
  const rows = (legacy ?? []).map((fact) => {
    const position = (byDate.get(fact.sent_date) ?? 0) + 1;
    byDate.set(fact.sent_date, position);
    return {
      legacyId: fact.id as string,
      row: {
        fact_key: keysByDate.get(fact.sent_date)![position - 1],
        publish_date: fact.sent_date,
        position,
        topic: fact.category,
        title: fact.title,
        key_fact: fact.key_fact,
        story: fact.story,
        tags: fact.tags ?? [],
        source: "migrated from daily_facts",
      },
    };
  });

  report("facts", `${rows.length} read from daily_facts`);

  if (!dryRun && rows.length) {
    const { error: insertError } = await db
      .from("pqb_facts")
      .upsert(
        rows.map((r) => r.row),
        { onConflict: "fact_key", ignoreDuplicates: true },
      );
    if (insertError) throw insertError;
  }

  // legacy fact id -> new fact_key, for backfilling questions.
  return new Map(rows.map((r) => [r.legacyId, r.row.fact_key]));
}

async function migrateQuizzes() {
  const { data: sessions, error } = await legacyDb
    .from("quiz_sessions")
    .select("*")
    .order("quiz_date");
  if (error) throw error;

  const mapping = new Map<string, string>();

  for (const session of sessions ?? []) {
    // Cadence inferred from length: 20 questions was the monthly format.
    const cadence: Cadence = (session.total_questions ?? 0) >= 20 ? "monthly" : "weekly";
    const periodEnd = session.quiz_date as string;
    const periodStart = new Date(`${periodEnd}T00:00:00Z`);
    periodStart.setUTCDate(periodStart.getUTCDate() - (cadence === "monthly" ? 30 : 7));
    const start = periodStart.toISOString().slice(0, 10);

    report("quiz", `${session.quiz_date} → ${cadence} (${start} to ${periodEnd})`);
    if (dryRun) continue;

    const { data: existing } = await db
      .from("pqb_quizzes")
      .select("id")
      .eq("cadence", cadence)
      .eq("period_start", start)
      .eq("period_end", periodEnd)
      .maybeSingle();

    if (existing) {
      mapping.set(session.id, existing.id);
      continue;
    }

    const { data: created, error: insertError } = await db
      .from("pqb_quizzes")
      .insert({
        cadence,
        period_start: start,
        period_end: periodEnd,
        // Archive: none of these is the current quiz.
        is_current: false,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    mapping.set(session.id, created.id);
  }

  return mapping;
}

async function migrateQuestions(
  quizIds: Map<string, string>,
  factKeys: Map<string, string>,
) {
  const { data: legacy, error } = await legacyDb
    .from("quiz_questions")
    .select("*")
    .order("session_id")
    .order("question_order");
  if (error) throw error;

  let unresolved = 0;
  const rows = [];

  for (const question of legacy ?? []) {
    const quizId = quizIds.get(question.session_id);
    if (!quizId && !dryRun) continue;

    const key = question.fact_id ? (factKeys.get(question.fact_id) ?? null) : null;
    if (!key) unresolved += 1;

    rows.push({
      quiz_id: quizId ?? "",
      // Questions whose fact can't be resolved keep a null key rather than a
      // guess. They simply don't feed the scheduler.
      fact_key: key,
      format: LEGACY_FORMAT[question.question_type] ?? "legacy_free_text",
      prompt: question.question_text,
      correct_answer: question.correct_answer,
      accepted_answers: [],
      explanation: null,
      // The old rows hotlink upload.wikimedia.org and flagcdn.com. Left as they
      // are: re-hosting an archive isn't worth an API call per image.
      image_path: question.image_url ?? null,
      image_credit: question.image_caption ?? null,
      position: question.question_order,
    });
  }

  report(
    "questions",
    `${rows.length} read, ${rows.length - unresolved} with a resolvable fact_key, ${unresolved} without`,
  );

  const legacyIdByPosition = new Map<string, string>();
  if (!dryRun && rows.length) {
    const { error: insertError } = await db
      .from("pqb_questions")
      .upsert(rows, { onConflict: "quiz_id,position", ignoreDuplicates: true });
    if (insertError) throw insertError;

    // Map old question id -> new question id, for the answers.
    for (const question of legacy ?? []) {
      const quizId = quizIds.get(question.session_id);
      if (!quizId) continue;
      const { data: created } = await db
        .from("pqb_questions")
        .select("id")
        .eq("quiz_id", quizId)
        .eq("position", question.question_order)
        .maybeSingle();
      if (created) legacyIdByPosition.set(question.id, created.id);
    }
  }

  return legacyIdByPosition;
}

async function migrateAnswersFor(
  user: string,
  quizIds: Map<string, string>,
  questionIds: Map<string, string>,
) {
  const { data: legacy, error } = await legacyDb.from("quiz_answers").select("*");
  if (error) throw error;

  const bySession = new Map<string, typeof legacy>();
  for (const answer of legacy ?? []) {
    const list = bySession.get(answer.session_id) ?? [];
    list.push(answer);
    bySession.set(answer.session_id, list);
  }

  report("answers", `${legacy?.length ?? 0} rows across ${bySession.size} session(s)`);
  if (dryRun) return;

  for (const [sessionId, answers] of bySession) {
    const quizId = quizIds.get(sessionId);
    if (!quizId || !answers) continue;

    const score = answers.filter((a) => a.is_correct).length;
    const submitted =
      answers.map((a) => a.answered_at).sort().at(-1) ?? new Date().toISOString();

    const { data: attempt, error: attemptError } = await db
      .from("pqb_attempts")
      .upsert(
        {
          user_id: user,
          quiz_id: quizId,
          submitted_at: submitted,
          score,
          total: answers.length,
        },
        { onConflict: "user_id,quiz_id" },
      )
      .select("id")
      .single();
    if (attemptError) throw attemptError;

    const rows = answers
      .map((answer) => ({
        attempt_id: attempt.id,
        question_id: questionIds.get(answer.question_id) ?? null,
        response: answer.user_answer ?? "",
        is_correct: answer.is_correct ?? false,
        answered_at: answer.answered_at,
      }))
      .filter((row) => row.question_id !== null);

    if (rows.length) {
      const { error: answerError } = await db
        .from("pqb_answers")
        .upsert(rows, { onConflict: "attempt_id,question_id", ignoreDuplicates: true });
      if (answerError) throw answerError;
    }

    report("answers", `${rows.length} written for quiz ${quizId} (scored ${score})`);
  }
}

async function main() {
  const factKeys = await migrateFacts();
  const quizIds = await migrateQuizzes();
  const questionIds = await migrateQuestions(quizIds, factKeys);

  if (migrateAnswers && userId) {
    await migrateAnswersFor(userId, quizIds, questionIds);
  } else {
    report(
      "answers",
      "skipped — pass --user <uuid> after signing in once, so the account exists",
    );
  }

  console.log(dryRun ? "\nDry run complete. Nothing was written." : "\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
