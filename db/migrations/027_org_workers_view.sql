-- =====================================================================
-- 027  org_workers: one list of an organisation's people, and a Hook can
--      point at one of them
--
-- Run in the Supabase SQL editor, after 026. Forward-only.
--
-- WHY A VIEW, NOT A TABLE
-- The people of an organisation already live in two places:
--   org_rosters  - uploaded by the employer (name, department, job title)
--   profiles     - registered users attached to the organisation
-- A separate workers table would be a third copy that every upload, claim,
-- join and change of workplace has to keep in step - and the one that
-- drifts is the one nobody notices. A view is always exactly as current as
-- its sources.
--
-- One row per person:
--   - every roster row (name from the profile once claimed, else the
--     employer's spelling)
--   - every attached profile with a name that is NOT already a claimed
--     roster row, so a registered employee is not listed twice
--
-- NO PHONE NUMBERS, deliberately. The "about whom" picker needs a name to
-- choose, not a way to contact anyone.
--
-- WHO MAY READ IT: nobody through the Supabase API. Grants are revoked and
-- it is security_invoker, so even if a grant came back, RLS on the source
-- tables (org_rosters has no policies) would still return nothing. The
-- server reads it with the service role, scoped to the caller's own,
-- employer-asserted organisation - see getWorkers.
-- =====================================================================

create view public.org_workers
with (security_invoker = true) as
  select r.id                                              as worker_id,
         r.organization_id,
         o.name                                            as organization_name,
         coalesce(nullif(p.full_name, ''), r.employee_name) as full_name,
         r.department,
         r.job_title,
         'roster'::text                                    as source,
         r.claimed_by                                      as user_id,
         r.added_at                                        as date
    from public.org_rosters r
    join public.organizations o on o.id = r.organization_id
    left join public.profiles p on p.id = r.claimed_by

  union all

  select p.id,
         p.organization_id,
         o.name,
         p.full_name,
         null,
         null,
         'registered',
         p.id,
         p.created_at
    from public.profiles p
    join public.organizations o on o.id = p.organization_id
   where nullif(p.full_name, '') is not null
     and not exists (select 1 from public.org_rosters r where r.claimed_by = p.id);

comment on view public.org_workers is
  'Everyone in an organisation: roster rows plus attached registered users. No phones. Server-only - see migration 027.';

revoke all on public.org_workers from public, anon, authenticated;

-- ------------------------------------------------- a Hook about a worker
-- Which person an "עובד/ת" Hook is about, when they were picked from the
-- list. No foreign key: a worker_id is either an org_rosters.id or a
-- profiles.id, and a roster row may be deleted later. target_name keeps the
-- name as it was at filing, as behavior_name does for the wording.
--
-- Same rule as target_name (migration 023): NEVER returned to an org admin.
alter table public.reports
  add column target_worker_id uuid;

comment on column public.reports.target_worker_id is
  'org_workers.worker_id the Hook is about, if picked from the list. Never returned to an org admin.';

create index reports_target_worker_idx on public.reports (target_worker_id)
  where target_worker_id is not null;

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select source, count(*) from public.org_workers group by source;
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'reports'
--      and column_name = 'target_worker_id';
