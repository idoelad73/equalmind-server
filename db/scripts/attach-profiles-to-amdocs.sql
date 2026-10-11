-- Attach every profile to אמדוקס (ישראל) בע~מ, for testing.
--
-- NOT a migration. Nothing here changes the schema, and it is written to be
-- safe to run twice. Run it in the Supabase SQL editor.
--
-- אמדוקס is the only organisation in the database right now, so "migrate all
-- workers to אמדוקס" means "attach everyone". The script names it by its
-- registry number rather than by its id, so it keeps working if the row is
-- ever recreated - and by its number rather than its name, because the name
-- carries a tilde standing in for a geresh and nobody types that twice the
-- same way.
--
-- Step 3 is commented out. Read the note above it before deciding.


-- ---------------------------------------------------------------- step 0
-- What it will do, before it does anything. Run this on its own first.

select p.id,
       u.email,
       p.user_type,
       p.organization_id is not null as attached_now,
       p.org_registry_id             as registry_now,
       p.org_source                  as source_now
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.created_at;


-- ---------------------------------------------------------------- step 1
-- Attach the profiles.
--
-- Only org_registry_id and org_name are set. organization_id and org_source
-- are left to the sync_profile_organization() trigger, which resolves the
-- number to the organisation row - writing organization_id by hand here
-- would be overwritten by that same trigger on the next edit of the row,
-- which is exactly the state one of these profiles is in now.
--
-- `where org_source is distinct from 'roster'` leaves alone anyone an
-- employer's roster has already claimed: a self-declaration does not get to
-- overrule the organisation's own list. Nobody is in that state today; the
-- clause is there so re-running this after a roster import cannot undo one.

update public.profiles p
   set org_registry_id = o.registry_id,
       org_name        = o.name
  from public.organizations o
 where o.registry_id = '511251217'
   and o.is_active
   and p.org_source is distinct from 'roster'
   and (p.org_registry_id is distinct from o.registry_id
        or p.organization_id is distinct from o.id);


-- ---------------------------------------------------------------- step 2
-- The org admin's own profile.
--
-- equalmind.app@gmail.com is already linked to אמדוקס in org_admins, which
-- is what the dashboard actually reads - so this changes nothing they can
-- see. It is here so the two tables agree: a profile with no organisation
-- belonging to someone who administers one is the kind of mismatch that
-- makes a later query quietly return nothing.
-- Step 1 already covers it. Nothing extra to run.


-- ---------------------------------------------------------------- step 3
-- Backfill the existing reports. Enabled on 2026-10-11 at the user's word:
-- this step used to be commented out, and is now part of the run.
--
-- Attaching a profile does NOT retro-fill the reports that profile already
-- filed. organization_id is stamped on a report when it is created, on
-- purpose: a report belongs to the employer the reporter had AT THE TIME,
-- so someone changing jobs cannot drag their history to a new employer.
--
-- The consequence for your test: right now all 10 reports have
-- organization_id null, so the org admin's dashboard will be empty even
-- after step 1. Six of the ten have no user_id at all and can never be
-- attributed to anyone. The four that do have one would become visible to
-- the אמדוקס admin.
--
-- That is the whole point of the feature, so it is worth being deliberate
-- about: this makes four existing reports readable by a person who could
-- not read them before. user_id still never leaves the server - the admin
-- endpoint names its columns explicitly - but the reports themselves
-- become theirs to read.

update public.reports r
   set organization_id = p.organization_id
  from public.profiles p
 where p.id = r.user_id
   and r.user_id is not null
   and r.organization_id is null
   and p.organization_id is not null;


-- ---------------------------------------------------------------- step 4
-- Confirm.

select u.email,
       p.user_type,
       p.org_name,
       p.org_registry_id,
       p.org_source,
       p.organization_id
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.created_at;

select coalesce(o.name, '(ללא ארגון)') as organization,
       count(*)::int                   as reports
  from public.reports r
  left join public.organizations o on o.id = r.organization_id
 group by 1
 order by 2 desc;
