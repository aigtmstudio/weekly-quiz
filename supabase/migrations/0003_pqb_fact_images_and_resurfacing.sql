-- Two additions.
--
-- 1. Facts can carry a picture. Without this the quiz picture round showed
--    images nobody had ever seen, because quiz generation resolved its own
--    Wikipedia articles independently of the daily briefing. Pictures now come
--    from the facts themselves, so the round tests recall rather than eyesight.
--
-- 2. pqb_resurfacings records which facts were brought back on which day.
--    The repetition scheduler previously ordered by pqb_fact_performance's
--    last_seen_at, which is max(attempt.submitted_at) — showing a fact in the
--    daily email changed nothing, so the ordering was identical every morning
--    and the same two facts came back forever. This is the missing memory.

alter table public.pqb_facts
  add column if not exists image_subject text,
  add column if not exists image_path    text,
  add column if not exists image_credit  text;

comment on column public.pqb_facts.image_subject is
  'English Wikipedia article whose lead image illustrates this fact, if any.';

create table if not exists public.pqb_resurfacings (
  user_id  uuid not null references auth.users(id) on delete cascade,
  fact_key text not null,
  shown_on date not null,
  primary key (user_id, fact_key, shown_on)
);

create index if not exists pqb_resurfacings_user_idx
  on public.pqb_resurfacings (user_id, shown_on desc);

alter table public.pqb_resurfacings enable row level security;

-- Server-side only, like the other bookkeeping tables: read and written by the
-- scheduler through the service-role client, never by a browser.
revoke all on public.pqb_resurfacings from anon, authenticated;
