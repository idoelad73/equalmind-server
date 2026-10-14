-- =====================================================================
-- 034  A message for every Hook, not only for the ones needing approval
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- Until now public.messages held one kind of row: a custom Hook proposing
-- wording that is not in the catalogue, waiting for a decision. A Hook
-- filed against an EXISTING catalogue behaviour proposed nothing, so it
-- created no message and staff never saw it arrive.
--
-- That was the design, and it is being changed on purpose: the queue is
-- also where staff learn that something was reported at all.
--
--   message_type = 'new_hook'   a proposal. Needs a decision: approving it
--                               inserts the wording into public.behaviors.
--
--   message_type = 'report'     a notification. The behaviour is already in
--                               the catalogue, so there is nothing to
--                               approve - only to read. Approving one marks
--                               it read and touches public.behaviors not at
--                               all (see approveMessage).
--
-- BOTH START pending, which is what the navbar badge counts, because both
-- are things staff have not looked at yet. The difference is what the
-- buttons do, not whether it is counted.
--
-- THE UNIQUE INDEX STAYS. messages_report_key is one message per report,
-- so a Hook cannot produce two notifications however many times the
-- insert path runs.
-- =====================================================================

alter table public.messages
  drop constraint messages_message_type_check;

alter table public.messages
  add constraint messages_message_type_check
    check (message_type in ('new_hook', 'report'));

comment on column public.messages.message_type is
  'new_hook = a proposal needing a decision; report = a Hook already in the '
  'catalogue, needing only to be read. Both start pending and both are counted '
  'by the badge.';

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.messages'::regclass
--      and conname = 'messages_message_type_check';
--   -- expect both 'new_hook' and 'report'
