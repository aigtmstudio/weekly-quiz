/**
 * Database types for the `pqb_*` tables.
 *
 * Hand-written rather than generated: this Supabase project is shared with
 * several other applications (~100 `ink_*` tables plus a handful of others),
 * so `supabase gen types` would produce an enormous file that is almost
 * entirely irrelevant here. Only tables this app touches are declared.
 */

export type Cadence = "weekly" | "monthly";
export type EmailCadence = "daily" | Cadence;

export type QuestionFormat =
  | "open_recall"
  | "fill_blank"
  | "explain_why"
  | "explain_significance"
  | "reverse"
  | "picture"
  | "legacy_multiple_choice"
  | "legacy_free_text"
  | "legacy_visual";

export type JobOutcome = "running" | "ok" | "error" | "skipped";

export type Fact = {
  id: string;
  fact_key: string;
  publish_date: string;
  position: number;
  topic: string;
  title: string;
  key_fact: string;
  story: string;
  tags: string[];
  source: string | null;
  image_subject: string | null;
  image_path: string | null;
  image_credit: string | null;
  created_at: string;
};

export type Quiz = {
  id: string;
  cadence: Cadence;
  period_start: string;
  period_end: string;
  published_at: string;
  is_current: boolean;
  created_at: string;
};

/** The full question row, including answers. Server-side only. */
export type Question = {
  id: string;
  quiz_id: string;
  fact_key: string | null;
  format: QuestionFormat;
  prompt: string;
  correct_answer: string;
  accepted_answers: string[];
  explanation: string | null;
  image_path: string | null;
  image_credit: string | null;
  position: number;
  created_at: string;
};

/** What a client is allowed to see: no answer, no explanation. */
export type PublicQuestion = Omit<
  Question,
  "correct_answer" | "accepted_answers" | "explanation" | "created_at"
>;

export type Member = {
  user_id: string;
  email: string;
  display_name: string;
  created_at: string;
};

export type AllowedEmail = {
  email: string;
  display_name: string;
  added_at: string;
};

export type Attempt = {
  id: string;
  user_id: string;
  quiz_id: string;
  started_at: string;
  submitted_at: string | null;
  score: number | null;
  total: number | null;
};

export type Answer = {
  id: string;
  attempt_id: string;
  question_id: string;
  response: string;
  is_correct: boolean;
  answered_at: string;
};

export type Preferences = {
  user_id: string;
  daily_email: boolean;
  weekly_email: boolean;
  monthly_email: boolean;
  send_hour: number;
  timezone: string;
  unsubscribed: boolean;
  undeliverable: boolean;
  updated_at: string;
};

export type JobRun = {
  id: string;
  job: string;
  period_key: string;
  started_at: string;
  finished_at: string | null;
  outcome: JobOutcome;
  summary: string | null;
};

export type EmailLogEntry = {
  id: string;
  user_id: string;
  cadence: EmailCadence;
  period_key: string;
  sent_at: string;
  provider_id: string | null;
};

/** One day's worth of facts brought back for one person. */
export type Resurfacing = {
  user_id: string;
  fact_key: string;
  shown_on: string;
};

export type SigninAttempt = {
  id: string;
  email: string;
  ip: string;
  requested_at: string;
};

/** Per user, per fact — the input to the repetition scheduler. */
export type FactPerformance = {
  user_id: string;
  fact_key: string;
  times_seen: number;
  times_wrong: number;
  last_seen_at: string | null;
  last_wrong_at: string | null;
};

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type View<Row> = { Row: Row; Relationships: [] };

// A type alias, not an interface: supabase-js constrains the schema to
// `Record<string, GenericTable>`, and only type aliases get an implicit index
// signature. Declared as an interface, every table silently resolves to `never`.
export type Database = {
  public: {
    Tables: {
      pqb_facts: Table<
        Fact,
        Omit<Fact, "id" | "created_at"> & { id?: string; created_at?: string }
      >;
      pqb_quizzes: Table<
        Quiz,
        Omit<Quiz, "id" | "published_at" | "created_at" | "is_current"> & {
          id?: string;
          published_at?: string;
          created_at?: string;
          is_current?: boolean;
        }
      >;
      pqb_questions: Table<
        Question,
        Omit<Question, "id" | "created_at" | "accepted_answers"> & {
          id?: string;
          created_at?: string;
          accepted_answers?: string[];
        }
      >;
      pqb_members: Table<Member, Omit<Member, "created_at"> & { created_at?: string }>;
      pqb_allowed_emails: Table<
        AllowedEmail,
        Omit<AllowedEmail, "added_at"> & { added_at?: string }
      >;
      pqb_attempts: Table<
        Attempt,
        Pick<Attempt, "user_id" | "quiz_id"> & Partial<Attempt>
      >;
      pqb_answers: Table<
        Answer,
        Pick<Answer, "attempt_id" | "question_id"> & Partial<Answer>
      >;
      pqb_preferences: Table<
        Preferences,
        Pick<Preferences, "user_id"> & Partial<Preferences>
      >;
      pqb_job_runs: Table<JobRun, Pick<JobRun, "job" | "period_key"> & Partial<JobRun>>;
      pqb_email_log: Table<
        EmailLogEntry,
        Pick<EmailLogEntry, "user_id" | "cadence" | "period_key"> &
          Partial<EmailLogEntry>
      >;
      pqb_resurfacings: Table<Resurfacing, Resurfacing>;
      pqb_signin_attempts: Table<
        SigninAttempt,
        Pick<SigninAttempt, "email"> & Partial<SigninAttempt>
      >;
    };
    Views: {
      pqb_questions_public: View<PublicQuestion>;
      pqb_fact_performance: View<FactPerformance>;
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
