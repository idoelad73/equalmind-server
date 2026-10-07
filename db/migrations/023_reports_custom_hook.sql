-- =====================================================================
-- 023  Custom Hooks: a report about a behaviour that is not in the catalogue
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- Step one of the wizard now offers "the Hook is not on the list, I want to
-- add one". Such a report has no behaviors row to point at, so:
--
--   behavior_id    becomes nullable. Null means "custom" - there is no
--                  separate flag to drift out of step with it.
--   behavior_name  stays NOT NULL and holds the reporter's own one-line
--                  description, so every consumer that already reads
--                  behavior_name (the org dashboard) needs no change.
--
-- A custom Hook also says who it is about, which a catalogue report does not
-- ask for yet:
--
--   target_type    employee | my_org | local_authority | business
--   target_name    free text: the employee's name, or the business's
--
-- target_name CAN NAME A PERSON. It is deliberately NOT returned by
-- listOrganizationReports: the about page promises that only the person
-- a Hook is about sees their flags - not their manager - and an org admin
-- is that manager. Treat it like user_id: never select it into an org
-- admin's response.
--
-- Custom rows double as the queue of catalogue suggestions:
--   select space, behavior_name, count(*) from public.reports
--    where behavior_id is null group by 1, 2 order by 3 desc;
-- =====================================================================

alter table public.reports
  alter column behavior_id drop not null,
  add column target_type text
    check (target_type in ('employee', 'my_org', 'local_authority', 'business')),
  add column target_name text
    check (target_name is null or length(target_name) <= 120);

-- An employee Hook without a name is about nobody.
alter table public.reports
  add constraint reports_employee_has_name
    check (target_type is distinct from 'employee' or target_name is not null);

comment on column public.reports.behavior_id is
  'Catalogue row the report was filed against. Null for a custom Hook - behavior_name then holds the reporter''s own wording.';
comment on column public.reports.target_type is
  'Who a custom Hook is about. Null on catalogue reports, which do not ask.';
comment on column public.reports.target_name is
  'May name a person. NEVER returned to an org admin - see the header of migration 023.';

create index reports_custom_idx on public.reports (space, created_at desc)
  where behavior_id is null;

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select column_name, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'reports'
--      and column_name in ('behavior_id', 'target_type', 'target_name');
--   -- expect behavior_id YES, and both target columns present
