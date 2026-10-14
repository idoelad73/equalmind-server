-- =====================================================================
-- 035  reports.review_status: the queue state lives on the Hook itself
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- Staff should learn about every Hook, not only the ones proposing new
-- catalogue wording. Two earlier shapes were tried and both were wrong:
--
--   a message row written when a Hook is filed - two writes at one moment,
--     and when the second is skipped or retried the queue and the reports
--     disagree with nobody to notice;
--
--   a status derived by left-joining messages - correct, but it makes the
--     commonest question in the product ("how many are waiting?") a join
--     over every report, and the answer unindexable.
--
-- So the state goes on the row it describes. One column, one write, one
-- place to look - and a partial index so the badge's count is cheap no
-- matter how many Hooks accumulate.
--
-- public.messages KEEPS ITS JOB: it is the record of the DECISION - who
-- acted, when, with what note, and what they corrected (edits, migration
-- 029). That is an audit trail and it belongs in its own table. The two
-- are written in one transaction, so they cannot drift.
--
-- A new Hook defaults to 'pending' with no insert code at all, which is
-- the real point: nothing has to remember to enqueue it.
-- =====================================================================

alter table public.reports
  add column review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'denied'));

comment on column public.reports.review_status is
  'Where this Hook stands in the staff queue. Defaults to pending for every '
  'new report - nothing has to enqueue it. The DECISION behind a non-pending '
  'value is in public.messages.';

-- Decisions already made keep them: without this every Hook ever reviewed
-- would reappear in the queue as new.
update public.reports r
   set review_status = m.status
  from public.messages m
 where m.report_id = r.id
   and m.status in ('approved', 'denied');

-- The badge counts exactly this, on every page load, for every staff
-- member. Partial so the index holds only the rows that are waiting.
create index reports_pending_idx on public.reports (created_at desc)
  where review_status = 'pending';

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select review_status, count(*)::int from public.reports group by 1;
--   -- pending plus whatever had already been decided
--
--   select count(*)::int as mismatched
--     from public.reports r join public.messages m on m.report_id = r.id
--    where m.status in ('approved','denied') and r.review_status <> m.status;
--   -- expect 0
