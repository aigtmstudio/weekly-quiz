# Pub Quiz Brain

Five facts a day, a quiz on whether they stuck, and facts you got wrong coming
back round on a spacing schedule. Built for two people.

This exists as code rather than scheduled Claude tasks for one reason: every
Supabase write used to go through an MCP connector, which raised an approval
prompt. A job scheduled for 07:00 had nobody to tap approve, so it failed
silently. Running on Vercel with secrets in environment variables means nothing
in the scheduled path needs approving.

**Keep it that way — never put a connector back into a scheduled job.**

## How it runs

Three daily crons, staggered two hours apart so Vercel's ±59 minutes of
scheduling imprecision can't reorder them. Each gets its own 300-second budget.

| Cron | Time (UTC) | What it does |
|---|---|---|
| `/api/cron/facts` | 01:00 | Eight facts for today, topics rotated |
| `/api/cron/quizzes` | 03:00 | Self-gating: weekly on Mondays, monthly on the 1st |
| `/api/cron/email` | `0 5,6 * * *` | Sends whatever is due, at 6am London |

The email fires at two hours on purpose. Vercel crons are UTC-only, so 6am
London is 05:00 UTC under BST and 06:00 UTC under GMT. Both fire and the route
drops whichever is before `SEND_HOUR` in London — returning *before* the
`pqb_job_runs` guard, so the later one is still free to do the work. Without
that, the daily email would silently arrive at 5am for five months of the year.

**It has to be one entry with two hours, not two entries.** Vercel keys cron
jobs by path, so two `{ "path": "/api/cron/email" }` entries are silently
collapsed into one and only the last schedule registers — no error, just a
delivery an hour late half the year. `vercel crons ls` shows what actually
registered, which is worth checking after any change here.

Ten topics rotate: history, music, geography, food and drink, science, art and
literature, sport, popular culture, politics, natural world. Eight publish each
day and two rest, advancing two positions daily — so the whole pool is covered
every five days and no topic ever rests twice running. The order of `TOPICS` is
load-bearing: topics rest in adjacent pairs, and the list is interleaved so the
closest-related ones (science/natural world, art/music) never rest together.

All three require `Authorization: Bearer $CRON_SECRET`, which Vercel sends
automatically for crons declared in `vercel.json`. Each is idempotent for its
period via `pqb_job_runs`, so a retry never double-produces.

### Pictures

Each fact nominates the Wikipedia article whose lead image shows its subject.
The picture is fetched once at generation time, stored in Blob under
`fact-images/`, and shown in the briefing — on the site and, as a `cid:`
attachment, in the email.

**The quiz's picture round draws only on facts that went out with a picture.**
It used to resolve its own Wikipedia article per question, independently of the
briefing, which meant the images were guaranteed to be ones nobody had ever
seen — an impossible round dressed up as a recall test. When too few facts in
the period have a picture, the round shrinks and written questions make up the
difference, so the quiz stays the length it should be (`specFor`).

Facts written before this existed have no picture, and a quiz covering them
would have no picture round. `/api/admin/backfill-images` fixes that on demand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "$SITE_URL/api/admin/backfill-images?days=14&limit=30"
```

It only touches facts with no `image_subject`, and records the subject even when
no usable image comes back, so nothing is retried for ever. Run it again while
`remaining` is above zero.

## Setting it up

1. **Environment variables.** Copy `.env.example` and fill it in, then
   `vercel env add` each one. The service-role key is server-only — never give
   it a `NEXT_PUBLIC_` name.

2. **Database.** Lives in the **Enablement App** project
   (`zpsljfgcjvshqxjbxgid`). The migrations in `supabase/migrations/` are
   already applied there. Every object is prefixed `pqb_` because that project
   also hosts around 70 tables from five other applications — including
   unprefixed `preferences`, `jobs`, `users` and `feedback`, which would have
   collided outright.

3. **Allowlist.** Nobody can request a sign-in link unless their address is in
   `pqb_allowed_emails`:

   ```sql
   insert into pqb_allowed_emails (email, display_name)
   values ('partner@example.com', 'Their name');
   ```

4. **Auth email.** In Supabase → Authentication → Emails, set Resend as custom
   SMTP so the magic links come from your own domain. Set the site URL to the
   deployment and add `/auth/callback` as a redirect URL.

5. **Blob store.** Link a Vercel Blob store to the project; picture-round images
   are downloaded once at generation time and served from there rather than
   hotlinked.

6. **Bounce webhook** (optional). Point a Resend webhook at
   `/api/webhooks/resend` for `email.bounced` and `email.complained`, and set
   `RESEND_WEBHOOK_SECRET`. A bounce marks the address undeliverable and stops
   sending until settings are saved again.

## Bringing the old data over

The legacy tables are in a **different project** (`xnausliedmpumzkfyrrx`, the
one this app used to share with inklined). They stay there — copying them into
the new project would only move the clutter. The script reads across both, so
it needs `LEGACY_SUPABASE_URL` and `LEGACY_SUPABASE_SERVICE_ROLE_KEY` as well
as the destination pair.

```bash
npm run migrate-legacy -- --dry-run          # counts only, writes nothing
npm run migrate-legacy                       # facts, quizzes, questions
npm run migrate-legacy -- --user <your-uuid> # also the 20 legacy answers
```

The answers step needs a `pqb_members` row, so sign in once first. There are 20
answers in total, all from one session, so expect the repetition scheduler to
start effectively cold regardless.

`daily_facts`, `quiz_sessions`, `quiz_questions`, `quiz_answers` and
`quiz_config` are read once and never written. After this they are a dead
archive, and the two `LEGACY_*` variables can be deleted.

## The two bugs this fixed

- **A shared quiz.** `quiz_sessions.is_active` was the only completion marker,
  so the first person to finish retired the quiz for everyone. A quiz and an
  attempt at a quiz are now separate rows, with `unique (user_id, quiz_id)` on
  attempts. Nothing a player does touches a quiz.
- **No user concept.** `quiz_answers` had no player column, so "which facts does
  this person keep getting wrong" was unanswerable and the learning loop never
  actually ran. Answers now hang off an attempt, which hangs off a person, and
  attach to a durable `fact_key` rather than to a question that only exists
  inside one week's quiz.
- **The same two facts every morning.** "Worth another look" ranked on
  `last_seen_at`, and every fact missed in one quiz shares that timestamp
  exactly — so the order was identical every day and the same two came back all
  week while the rest of the backlog waited. Showing a fact now has its own
  clock (`pqb_resurfacings`), the ranking puts whatever has waited longest
  first, and a fact stands down for `RESURFACE_COOLDOWN_DAYS` once shown.

## Checking it

```bash
npm test           # 92 tests, no network
npm run typecheck
npm run build
```

Then, by hand before trusting the crons:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/cron/facts
```

Call it twice — the second call should report `skipped` and today should still
have exactly eight facts.

The real success condition is the morning after deploying: all three crons ran
and no approval prompt appeared anywhere.
