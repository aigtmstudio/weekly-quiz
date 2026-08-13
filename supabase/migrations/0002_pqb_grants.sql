-- Grants. This must run after 0001 and is not optional.
--
-- Supabase applies default privileges that grant ALL on newly created objects
-- in `public` to anon and authenticated. For the base tables RLS still blocks
-- the writes, but for pqb_questions_public that default is an actual hole:
-- it is a single-table, auto-updatable view created with
-- security_invoker = false, so a write through the view executes as the view
-- owner and bypasses RLS on pqb_questions completely. Left alone, an anonymous
-- caller could insert or rewrite quiz questions.
--
-- Strip everything back, then grant only what each role genuinely needs.

revoke all on public.pqb_facts             from anon, authenticated;
revoke all on public.pqb_quizzes           from anon, authenticated;
revoke all on public.pqb_questions         from anon, authenticated;
revoke all on public.pqb_questions_public  from anon, authenticated;
revoke all on public.pqb_fact_performance  from anon, authenticated;
revoke all on public.pqb_members           from anon, authenticated;
revoke all on public.pqb_allowed_emails    from anon, authenticated;
revoke all on public.pqb_attempts          from anon, authenticated;
revoke all on public.pqb_answers           from anon, authenticated;
revoke all on public.pqb_preferences       from anon, authenticated;
revoke all on public.pqb_job_runs          from anon, authenticated;
revoke all on public.pqb_email_log         from anon, authenticated;
revoke all on public.pqb_signin_attempts   from anon, authenticated;

-- Read-only published content.
grant select on public.pqb_facts            to anon, authenticated;
grant select on public.pqb_quizzes          to anon, authenticated;
grant select on public.pqb_questions_public to anon, authenticated;

-- Personal data: still gated by RLS on top of these grants.
grant select                 on public.pqb_members     to authenticated;
grant select, insert, update on public.pqb_attempts    to authenticated;
grant select, insert, update on public.pqb_answers     to authenticated;
grant select, insert, update on public.pqb_preferences to authenticated;

-- Deliberately left at zero client privileges, reachable only via the
-- service-role key: pqb_questions (holds the answers), pqb_allowed_emails,
-- pqb_job_runs, pqb_email_log, pqb_signin_attempts, and pqb_fact_performance
-- (whose security_invoker join would fail for a client anyway).
