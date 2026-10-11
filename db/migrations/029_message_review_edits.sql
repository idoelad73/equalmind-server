-- =====================================================================
-- 029  The reviewer may correct a Hook before approving it - and the
--      original is kept.
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- Until now a system admin could change two things at approval: the
-- wording that joins the catalogue, and its category. Everything else the
-- reporter wrote - who it is about, where, when, the free text - was
-- read-only. Staff now edit all of it.
--
-- THAT IS AN EDIT TO SOMEBODY ELSE'S REPORT. A report is evidence about a
-- moment; a queue that silently rewrites one is worse than a queue that
-- cannot. So every change is recorded here before it is applied:
--
--   {"behavior_name": {"from": "...", "to": "..."},
--    "locality_name": {"from": null,  "to": "כפר סבא"}}
--
-- Only fields that actually changed appear. An approval that corrected
-- nothing leaves this null, which is the common case and reads as such.
--
-- It lives on messages rather than on reports because it describes a
-- REVIEW DECISION, not the report: who changed what, at the moment of
-- approval, alongside handled_by and handling_note. The reports table
-- stays what it has always been - the current state of the Hook.
--
-- Staff-only, like the rest of this table. RLS is on with no policies,
-- so nothing reaches a client except through an endpoint behind
-- requireSystemAdmin.
-- =====================================================================

alter table public.messages
  add column edits jsonb;

comment on column public.messages.edits is
  'What the reviewer changed at approval: {"column": {"from": ..., "to": ...}}. '
  'Null when nothing was corrected. The record of an edit to a reporter''s own '
  'words - never drop it to tidy up.';

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'messages'
--      and column_name = 'edits';
--   -- expect one row, jsonb
