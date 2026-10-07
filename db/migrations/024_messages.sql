-- =====================================================================
-- 024  messages: the system admin's review queue
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- A Hook filed against something not in the catalogue is a proposal as
-- much as a report. This is where that proposal waits for Equalmind staff
-- to approve or reject it.
--
-- WHAT THIS DELIBERATELY IS NOT: an anonymous row. It carries user_id and
-- a snapshot of the reporter's name, because a system admin reviewing
-- free text needs to know who wrote it - that is the whole point of a
-- moderation queue. The ORGANISATION still never sees any of this; the
-- org admin's view reads public.reports, which returns no reporter.
--
-- The report itself stays as it was. Deleting a message does not delete
-- the Hook, and rejecting one does not retract it - this table decides
-- whether the wording joins the catalogue, not whether the report counts.
-- =====================================================================

create table public.messages (
  message_id    uuid primary key default gen_random_uuid(),

  -- set null, not cascade: a deleted account must not erase the queue.
  user_id       uuid references auth.users (id) on delete set null,

  -- Snapshot, like reports.behavior_name. The profile may be renamed or
  -- removed; what the reviewer saw should still read the same later.
  user_name     text,

  new_hook_text text not null,

  -- Named `date` because that is the field the product asked for. It is a
  -- timestamp, not a calendar day.
  date          timestamptz not null default now(),

  message_type  text not null default 'new_hook'
                  check (message_type in ('new_hook')),

  -- Not in the original field list, but approve/deny has to leave a mark
  -- somewhere, and the unread badge counts exactly this.
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'denied')),

  -- Which Hook this is about. restrict would block tidying up reports;
  -- set null keeps the proposal readable if the report is ever removed.
  report_id     uuid references public.reports (id) on delete set null,

  handled_at    timestamptz,
  handled_by    uuid references auth.users (id) on delete set null,
  handling_note text,

  created_at    timestamptz not null default now()
);

comment on table public.messages is
  'Review queue for Hooks filed outside the catalogue. Carries the reporter on purpose - staff only, never reaches an organisation.';
comment on column public.messages.status is
  'pending until a system admin acts. The navbar badge counts pending rows.';

-- The badge query, and the queue itself: pending first, newest first.
create index messages_pending_idx on public.messages (message_type, date desc)
  where status = 'pending';
create index messages_status_idx on public.messages (status, date desc);
create index messages_report_idx on public.messages (report_id)
  where report_id is not null;

-- One proposal per Hook. A retried submission updates rather than filling
-- the queue with duplicates of the same wording.
create unique index messages_report_key on public.messages (report_id)
  where report_id is not null;

-- ------------------------------------------------------------------- RLS
-- Enabled with no policies: the anon key can neither read nor write this.
-- Everything goes through the API behind requireSystemAdmin, which reads
-- the role from profiles with the service role rather than from a token
-- claim - the same rule as requireOrgAdmin.
alter table public.messages enable row level security;
