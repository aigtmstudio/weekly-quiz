-- Pub Quiz Brain — core schema.
--
-- NOTE ON NAMING: this app lives in the "Enablement App" Supabase project,
-- which is shared with several other applications (~70 tables: scheduler_*,
-- daily_analyst_*, haro_*, companies/contacts/lists, meal_plans/workout_logs
-- and so on). Every object here is therefore prefixed `pqb_` so nothing
-- collides now or later. Note in particular that unprefixed `preferences`,
-- `jobs`, `users` and `feedback` already exist and belong to other apps.
--
-- The legacy tables (daily_facts, quiz_sessions, quiz_questions, quiz_answers,
-- quiz_config) are in a DIFFERENT project and stay there. scripts/migrate-legacy.ts
-- reads them across the two projects once; afterwards they are a dead archive.
--
-- The central correction to the old schema: a quiz and an attempt at a quiz
-- are separate things, and a fact has an identity (fact_key) that outlives the
-- quiz that tested it.

-- ---------------------------------------------------------------------------
-- Facts
-- ---------------------------------------------------------------------------

create table if not exists public.pqb_facts (
  id            uuid primary key default gen_random_uuid(),
  fact_key      text not null unique,
  publish_date  date not null,
  position      int  not null,
  topic         text not null,
  title         text not null,
  key_fact      text not null,
  story         text not null,
  tags          text[] not null default '{}',
  source        text,
  created_at    timestamptz not null default now(),
  unique (publish_date, position)
);

create index if not exists pqb_facts_publish_date_idx on public.pqb_facts (publish_date desc);

-- ---------------------------------------------------------------------------
-- Quizzes  (definitions — never modified by a player)
-- ---------------------------------------------------------------------------

create table if not exists public.pqb_quizzes (
  id            uuid primary key default gen_random_uuid(),
  cadence       text not null check (cadence in ('weekly', 'monthly')),
  period_start  date not null,
  period_end    date not null,
  published_at  timestamptz not null default now(),
  is_current    boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (cadence, period_start, period_end)
);

-- At most one current quiz per cadence. Publishing a new one flips the old.
create unique index if not exists pqb_quizzes_one_current_per_cadence
  on public.pqb_quizzes (cadence) where is_current;

-- ---------------------------------------------------------------------------
-- Questions
--
-- correct_answer / accepted_answers / explanation live here and are NEVER
-- served to a client before submission. Clients read pqb_questions_public
-- (below), which omits those columns entirely.
-- ---------------------------------------------------------------------------

create table if not exists public.pqb_questions (
  id               uuid primary key default gen_random_uuid(),
  quiz_id          uuid not null references public.pqb_quizzes(id) on delete cascade,
  fact_key         text,
  format           text not null check (format in (
                     'open_recall', 'fill_blank', 'explain_why',
                     'explain_significance', 'reverse', 'picture',
                     'legacy_multiple_choice', 'legacy_free_text', 'legacy_visual'
                   )),
  prompt           text not null,
  correct_answer   text not null,
  accepted_answers text[] not null default '{}',
  explanation      text,
  image_path       text,
  image_credit     text,
  position         int not null,
  created_at       timestamptz not null default now(),
  unique (quiz_id, position)
);

create index if not exists pqb_questions_quiz_idx on public.pqb_questions (quiz_id);
create index if not exists pqb_questions_fact_key_idx on public.pqb_questions (fact_key);

-- ---------------------------------------------------------------------------
-- Membership
--
-- Access is gated on a row existing here, not merely on having an auth account.
-- auth.users happens to be empty of other apps in this project today, but the
-- project is shared and that could change without notice.
-- ---------------------------------------------------------------------------

create table if not exists public.pqb_members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null unique,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- Sign-in allowlist. Checked in the app before a magic link is ever sent, so
-- an unknown address can never even start the flow.
create table if not exists public.pqb_allowed_emails (
  email        text primary key,
  display_name text not null,
  added_at     timestamptz not null default now()
);

create or replace function public.pqb_is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.pqb_members m where m.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Attempts and answers
--
-- unique (user_id, quiz_id) is the fix for the bug that started this project:
-- one attempt per person per quiz, and a quiz's own state is untouched by
-- anybody completing it.
-- ---------------------------------------------------------------------------

create table if not exists public.pqb_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  quiz_id      uuid not null references public.pqb_quizzes(id) on delete cascade,
  started_at   timestamptz not null default now(),
  submitted_at timestamptz,
  score        int,
  total        int,
  unique (user_id, quiz_id)
);

create index if not exists pqb_attempts_user_idx on public.pqb_attempts (user_id, submitted_at desc);

create table if not exists public.pqb_answers (
  id           uuid primary key default gen_random_uuid(),
  attempt_id   uuid not null references public.pqb_attempts(id) on delete cascade,
  question_id  uuid not null references public.pqb_questions(id) on delete cascade,
  response     text not null default '',
  is_correct   boolean not null default false,
  answered_at  timestamptz not null default now(),
  unique (attempt_id, question_id)
);

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------

create table if not exists public.pqb_preferences (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  daily_email    boolean not null default true,
  weekly_email   boolean not null default true,
  monthly_email  boolean not null default true,
  send_hour      int not null default 7 check (send_hour between 0 and 23),
  timezone       text not null default 'Europe/London',
  unsubscribed   boolean not null default false,
  undeliverable  boolean not null default false,
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Operational bookkeeping
-- ---------------------------------------------------------------------------

-- Idempotency guard AND the answer to "did the job actually run".
create table if not exists public.pqb_job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text not null,
  period_key  text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  outcome     text not null default 'running' check (outcome in ('running', 'ok', 'error', 'skipped')),
  summary     text,
  unique (job, period_key)
);

-- A retry never double-sends.
create table if not exists public.pqb_email_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  period_key  text not null,
  sent_at     timestamptz not null default now(),
  provider_id text,
  unique (user_id, cadence, period_key)
);

-- Sign-in rate limiting. The allowlist already stops an unknown address
-- triggering an email at all, so the remaining abuse is someone hammering the
-- form with the two known addresses to spam them.
create table if not exists public.pqb_signin_attempts (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  ip           text not null default 'unknown',
  requested_at timestamptz not null default now()
);

create index if not exists pqb_signin_attempts_email_idx
  on public.pqb_signin_attempts (email, requested_at desc);
create index if not exists pqb_signin_attempts_ip_idx
  on public.pqb_signin_attempts (ip, requested_at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- What a client is allowed to see about a question: no correct_answer, no
-- accepted_answers, no explanation. security_invoker is intentionally OFF so
-- this view can read the RLS-locked base table and hand back the safe columns.
-- See 0002 for why that makes its grants security-critical.
create or replace view public.pqb_questions_public
with (security_invoker = false) as
select
  q.id,
  q.quiz_id,
  q.fact_key,
  q.format,
  q.prompt,
  q.image_path,
  q.image_credit,
  q.position
from public.pqb_questions q;

-- Per user, per fact: the input to the repetition scheduler. Server-side only —
-- it runs with security_invoker = true and joins pqb_questions, which clients
-- have no privileges on, so a client select would fail rather than return rows.
create or replace view public.pqb_fact_performance
with (security_invoker = true) as
select
  a.user_id,
  q.fact_key,
  count(*)::int                                          as times_seen,
  count(*) filter (where not ans.is_correct)::int        as times_wrong,
  max(a.submitted_at)                                    as last_seen_at,
  max(a.submitted_at) filter (where not ans.is_correct)  as last_wrong_at
from public.pqb_answers ans
join public.pqb_attempts a  on a.id = ans.attempt_id
join public.pqb_questions q on q.id = ans.question_id
where a.submitted_at is not null
  and q.fact_key is not null
group by a.user_id, q.fact_key;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Content (facts, quizzes) is world-readable — an anonymous visitor can look
-- at today's facts to decide whether it's worth joining. Everything personal
-- is scoped to the owner. Nothing here is client-writable: all writes to
-- content tables go through cron routes using the service-role key.
-- ---------------------------------------------------------------------------

alter table public.pqb_facts           enable row level security;
alter table public.pqb_quizzes         enable row level security;
alter table public.pqb_questions       enable row level security;
alter table public.pqb_members         enable row level security;
alter table public.pqb_allowed_emails  enable row level security;
alter table public.pqb_attempts        enable row level security;
alter table public.pqb_answers         enable row level security;
alter table public.pqb_preferences     enable row level security;
alter table public.pqb_job_runs        enable row level security;
alter table public.pqb_email_log       enable row level security;
alter table public.pqb_signin_attempts enable row level security;

-- Published content: readable by anyone. No insert/update/delete policy exists,
-- so no client can write regardless of authentication.
drop policy if exists pqb_facts_read on public.pqb_facts;
create policy pqb_facts_read on public.pqb_facts for select using (true);

drop policy if exists pqb_quizzes_read on public.pqb_quizzes;
create policy pqb_quizzes_read on public.pqb_quizzes for select using (true);

-- pqb_questions has NO select policy on purpose. Clients must go through
-- pqb_questions_public (which omits the answer columns) or the submit API.

-- Own membership row only.
drop policy if exists pqb_members_read_own on public.pqb_members;
create policy pqb_members_read_own on public.pqb_members
  for select using (user_id = auth.uid());

-- pqb_allowed_emails, pqb_job_runs, pqb_email_log and pqb_signin_attempts have
-- no client policies at all — server-side reads and writes only.

-- Attempts: read and write only your own, and only if you're a member.
drop policy if exists pqb_attempts_read_own on public.pqb_attempts;
create policy pqb_attempts_read_own on public.pqb_attempts
  for select using (user_id = auth.uid() and public.pqb_is_member());

drop policy if exists pqb_attempts_insert_own on public.pqb_attempts;
create policy pqb_attempts_insert_own on public.pqb_attempts
  for insert with check (user_id = auth.uid() and public.pqb_is_member());

-- Only an unsubmitted attempt may be modified — a submitted score is final.
drop policy if exists pqb_attempts_update_own on public.pqb_attempts;
create policy pqb_attempts_update_own on public.pqb_attempts
  for update using (user_id = auth.uid() and submitted_at is null)
  with check (user_id = auth.uid());

-- Answers: reachable only through an attempt you own.
drop policy if exists pqb_answers_read_own on public.pqb_answers;
create policy pqb_answers_read_own on public.pqb_answers
  for select using (exists (
    select 1 from public.pqb_attempts a
    where a.id = pqb_answers.attempt_id and a.user_id = auth.uid()
  ));

drop policy if exists pqb_answers_write_own on public.pqb_answers;
create policy pqb_answers_write_own on public.pqb_answers
  for insert with check (exists (
    select 1 from public.pqb_attempts a
    where a.id = pqb_answers.attempt_id
      and a.user_id = auth.uid()
      and a.submitted_at is null
  ));

drop policy if exists pqb_answers_update_own on public.pqb_answers;
create policy pqb_answers_update_own on public.pqb_answers
  for update using (exists (
    select 1 from public.pqb_attempts a
    where a.id = pqb_answers.attempt_id
      and a.user_id = auth.uid()
      and a.submitted_at is null
  ));

-- Preferences: your own row.
drop policy if exists pqb_preferences_all_own on public.pqb_preferences;
create policy pqb_preferences_all_own on public.pqb_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- The sign-in lookup lowercases the typed address and matches it exactly, so a
-- row stored with capitals silently never matches — and the form deliberately
-- cannot tell you that, because it must not reveal who has an account.
-- Fail loudly at insert time instead.
-- ---------------------------------------------------------------------------

alter table public.pqb_allowed_emails
  drop constraint if exists pqb_allowed_emails_lowercase;
alter table public.pqb_allowed_emails
  add constraint pqb_allowed_emails_lowercase check (email = lower(email));
