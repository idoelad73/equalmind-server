-- =====================================================================
-- 026  org_admins stops holding a second copy of the person
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- org_admins and org_admin_details both carried full_name and mobile for
-- the same person, and they disagreed: org_admins held nulls while
-- org_admin_details held what the admin actually typed at onboarding.
--
-- The split between the two tables is deliberate and stays. org_admins is
-- the GRANT - organization_id there decides whose reports you can read,
-- which is why it has a SELECT policy and nothing else. org_admin_details
-- is the admin's own DECLARATION, which is why they may insert and update
-- it. RLS restricts which rows you may write, not which columns, so one
-- merged table would mean letting someone edit the column that decides
-- what they can see.
--
-- What was never justified is storing the person twice. Only the old CLI
-- flags (--name / --mobile) ever populated these; the onboarding form
-- writes to org_admin_details, which is the one place that now answers
-- "who is this admin".
--
-- contact_email stays: it records the address the invitation was sent to,
-- which is a fact about the grant rather than about the person, and it
-- can differ from whatever they later put on the form.
-- =====================================================================

alter table public.org_admins
  drop column if exists full_name,
  drop column if exists mobile;

comment on table public.org_admins is
  'Which user administers which organisation - the grant. Service-role writable only. Who they are lives in org_admin_details.';
comment on column public.org_admins.contact_email is
  'The address the invitation was sent to. A fact about the grant, not the person.';
