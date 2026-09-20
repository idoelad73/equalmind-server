-- =====================================================================
-- Reports gain a reporter and an organisation.
--
-- This REPLACES the rule in the header of migration 010. "Anonymous" now
-- means anonymous *to the organisation*, not anonymous to Equalmind -
-- which is how most reporting platforms work, and what the product has
-- decided. Migration 010's header has been corrected accordingly.
--
-- THE RULE THAT REPLACES IT:
--
--   organization_id is what an org admin is allowed to filter on.
--   user_id is what an org admin must NEVER see.
--
-- Those two columns sitting in one row is the whole risk. An org admin
-- reading their organisation's reports is one careless `select *` away
-- from reading who filed each one - and the person filing is often
-- reporting about the very person who would be reading.
--
-- So: RLS on reports stays enabled with NO policies. The anon key cannot
-- reach this table at all, and every org-admin read goes through
-- controllers/reports.controller.js, which names its columns explicitly
-- and never includes user_id.
-- =====================================================================

alter table public.reports
  -- set null, not cascade: deleting an account must not destroy the
  -- reports filed against an organisation.
  add column user_id uuid references auth.users (id) on delete set null,
  add column organization_id uuid references public.organizations (id) on delete set null;

comment on column public.reports.user_id is
  'The reporter. NEVER exposed to an org admin - see the header of this migration.';
comment on column public.reports.organization_id is
  'Which organisation the report is routed to. Derived server-side from the reporter''s verified affiliation, never sent by the client.';

-- The org admin dashboard's only query shape: one organisation, newest first.
create index reports_organization_created_idx
  on public.reports (organization_id, created_at desc)
  where organization_id is not null;

create index reports_user_idx
  on public.reports (user_id)
  where user_id is not null;

-- Correct migration 010's now-wrong table comment.
comment on table public.reports is
  'Reports. Anonymous to the organisation: org admins read organization_id, never user_id.';
