import { siteUrl } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import { dailyEmail, quizEmail, type EmailBody } from "@/lib/email/templates";
import { repeatsForUser } from "@/lib/repetition";
import { createAdminClient } from "@/lib/supabase/admin";
import { unsubscribeUrl } from "@/lib/unsubscribe";
import type { Cadence, EmailCadence, Fact, Preferences, Question, Quiz } from "@/lib/types";

/**
 * One daily job sends whatever is due. For two people on one send hour the
 * PRD's frequent dispatcher would be machinery without a purpose.
 *
 * Idempotency comes from pqb_email_log, unique on (user_id, cadence,
 * period_key): the row is claimed before the send, and released again only if
 * the send fails. A retry therefore never double-sends.
 */

/**
 * When each kind of email goes out, London time. Nothing is sent before its
 * hour, and the cron in vercel.json must fire at every one of them — under both
 * BST and GMT, which is why it lists four UTC hours for two London ones.
 *
 * Lives here rather than in the route so it can be tested without dragging in
 * next/server, and so the schedule has one thing to agree with.
 */
export const SEND_HOURS = {
  /** The daily briefing: a two-minute read over breakfast. */
  daily: 6,
  /** Weekly and monthly quizzes, two hours later so they don't arrive together. */
  quiz: 8,
} as const;

export type EmailKind = keyof typeof SEND_HOURS;

/** Kept for the daily briefing's own send hour. */
export const SEND_HOUR = SEND_HOURS.daily;

interface Recipient {
  user_id: string;
  email: string;
  preferences: Preferences | null;
}

async function recipients(): Promise<Recipient[]> {
  const db = createAdminClient();

  const [{ data: members, error }, { data: preferences }] = await Promise.all([
    db.from("pqb_members").select("user_id, email"),
    db.from("pqb_preferences").select("*"),
  ]);
  if (error) throw error;

  const byUser = new Map((preferences ?? []).map((row) => [row.user_id, row]));

  return (members ?? [])
    .map((member) => ({
      user_id: member.user_id,
      email: member.email,
      preferences: byUser.get(member.user_id) ?? null,
    }))
    .filter(({ preferences: p }) => !p?.unsubscribed && !p?.undeliverable);
}

function wants(recipient: Recipient, cadence: EmailCadence): boolean {
  const p = recipient.preferences;
  if (!p) return true; // No row yet means defaults, which are all on.
  if (cadence === "daily") return p.daily_email;
  if (cadence === "weekly") return p.weekly_email;
  return p.monthly_email;
}

/**
 * Claim the right to send, send, and release the claim if sending failed.
 * Returns true if an email actually went out.
 */
async function sendOnce(
  recipient: Recipient,
  cadence: EmailCadence,
  periodKey: string,
  build: () => Promise<EmailBody>,
): Promise<boolean> {
  const db = createAdminClient();

  const claim = await db
    .from("pqb_email_log")
    .insert({ user_id: recipient.user_id, cadence, period_key: periodKey })
    .select("id")
    .single();

  if (claim.error) {
    // 23505: already sent for this period.
    if (claim.error.code === "23505") return false;
    throw claim.error;
  }

  const unsubscribe = unsubscribeUrl(recipient.user_id);

  try {
    const body = await build();
    const { id } = await sendEmail(recipient.email, body, unsubscribe);
    await db.from("pqb_email_log").update({ provider_id: id }).eq("id", claim.data.id);
    return true;
  } catch (error) {
    // Release the claim so the next run can try again.
    await db.from("pqb_email_log").delete().eq("id", claim.data.id);
    throw error;
  }
}

export interface DispatchSummary {
  daily: number;
  weekly: number;
  monthly: number;
  failures: string[];
}

/**
 * Send what is due. `kinds` narrows it to one wave, so the 6am run sends the
 * briefing and the 8am run sends the quiz.
 */
export async function dispatchEmail(
  date: string,
  kinds: readonly EmailKind[] = ["daily", "quiz"],
): Promise<DispatchSummary> {
  const db = createAdminClient();
  const people = await recipients();
  const summary: DispatchSummary = { daily: 0, weekly: 0, monthly: 0, failures: [] };

  if (people.length === 0) return summary;

  const { data: facts } = await db
    .from("pqb_facts")
    .select("*")
    .eq("publish_date", date)
    .order("position");

  const { data: quizzes } = await db
    .from("pqb_quizzes")
    .select("*")
    .eq("is_current", true);

  const site = siteUrl();

  for (const person of people) {
    if (kinds.includes("daily") && facts && facts.length > 0 && wants(person, "daily")) {
      try {
        const sent = await sendOnce(person, "daily", date, async () =>
          dailyEmail({
            date,
            facts: facts as Fact[],
            repeats: await repeatsForUser(person.user_id, date),
            siteUrl: site,
            unsubscribeUrl: unsubscribeUrl(person.user_id),
          }),
        );
        if (sent) summary.daily += 1;
      } catch (error) {
        summary.failures.push(`daily/${person.email}: ${message(error)}`);
      }
    }

    for (const quiz of (kinds.includes("quiz") ? ((quizzes ?? []) as Quiz[]) : [])) {
      const cadence = quiz.cadence as Cadence;
      if (!wants(person, cadence)) continue;

      try {
        // The quiz id is the period key: exactly one email per quiz per person,
        // whenever they joined.
        const sent = await sendOnce(person, cadence, quiz.id, async () => {
          const { data: questions, error } = await db
            .from("pqb_questions")
            .select("*")
            .eq("quiz_id", quiz.id)
            .order("position");
          if (error) throw error;

          return quizEmail({
            cadence,
            periodStart: quiz.period_start,
            periodEnd: quiz.period_end,
            questions: (questions ?? []) as Question[],
            quizUrl: `${site}/quiz/${quiz.id}`,
            siteUrl: site,
            unsubscribeUrl: unsubscribeUrl(person.user_id),
          });
        });
        if (sent) summary[cadence] += 1;
      } catch (error) {
        summary.failures.push(`${cadence}/${person.email}: ${message(error)}`);
      }
    }
  }

  return summary;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
