-- ---------------------------------------------------------------------------
-- Multiple choice
--
-- The original rule was no multiple choice anywhere: picking one of four does
-- not prove a fact stuck. In practice a written answer to "why did X happen"
-- cannot be marked by string comparison, and a quiz that scores 1/13 on
-- answers that were substantially right is worse than one that is a little
-- easier to guess. Most questions now offer options; a written answer is kept
-- only where the answer is a short name or number.
--
-- `options` is deliberately visible to clients — they cannot answer without
-- seeing the choices. correct_answer stays server-side as before, so the
-- options tell a client which four are possible and nothing about which is
-- right.
-- ---------------------------------------------------------------------------

alter table public.pqb_questions
  add column if not exists options text[] not null default '{}';

alter table public.pqb_questions
  drop constraint if exists pqb_questions_format_check;

alter table public.pqb_questions
  add constraint pqb_questions_format_check check (format in (
    'multiple_choice',
    'open_recall', 'fill_blank', 'explain_why',
    'explain_significance', 'reverse', 'picture',
    'legacy_multiple_choice', 'legacy_free_text', 'legacy_visual'
  ));

-- A multiple-choice question needs choices; anything else must not carry them.
alter table public.pqb_questions
  drop constraint if exists pqb_questions_options_check;

alter table public.pqb_questions
  add constraint pqb_questions_options_check check (
    case when format = 'multiple_choice'
      then array_length(options, 1) between 3 and 5
      else options = '{}'
    end
  );

-- Recreate the public view with options included. Still no correct_answer, no
-- accepted_answers, no explanation, and still security_invoker = false so it
-- can read the RLS-locked base table — which is why 0002's grants matter.
--
-- `options` goes on the END of the select list on purpose: create or replace
-- can only append columns, and inserting one mid-list would need a drop, which
-- would take the view's grants with it.
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
  q.position,
  q.options
from public.pqb_questions q;

-- create or replace resets ownership-derived privileges on some setups; assert
-- the intended grants rather than assuming they survived.
revoke all on public.pqb_questions_public from anon, authenticated;
grant select on public.pqb_questions_public to anon, authenticated;
