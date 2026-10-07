-- =====================================================================
-- 026  Roster rows gain a department and a job title
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- The roster file now has four columns: שם and טלפון required, מחלקה and
-- תפקיד optional. The two new ones are stored as given - free text, the
-- employer's own wording - and both may be null.
--
-- Same status as employee_name: third-party personal data about people who
-- have not signed up. Kept so an org admin can recognise and later segment
-- their own list. Never shown outside that organisation's admins.
-- =====================================================================

alter table public.org_rosters
  add column department text check (department is null or length(department) <= 120),
  add column job_title  text check (job_title  is null or length(job_title)  <= 120);

comment on column public.org_rosters.department is
  'Optional, from the roster file''s מחלקה column. Employer-supplied free text.';
comment on column public.org_rosters.job_title is
  'Optional, from the roster file''s תפקיד column. Employer-supplied free text.';

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'org_rosters'
--      and column_name in ('department', 'job_title');
--   -- expect two rows
