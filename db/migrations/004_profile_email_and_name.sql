-- =====================================================================
-- 004  Email and name on profiles
--
-- Run after 003, in the Supabase SQL editor. Forward-only.
--
-- WHY MIRROR THE EMAIL AT ALL
-- It already exists on auth.users, so this is denormalisation. The reason is
-- reach: the client can select from public.profiles under RLS, but cannot
-- read the auth schema, and joining auth.users into every query needs the
-- service role. Mirroring keeps ordinary reads simple.
--
-- The cost of denormalising is drift, so the mirror is maintained by
-- triggers rather than by application code - see sync_profile_from_auth
-- below, which fires whenever the auth record changes.
--
-- full_name is nullable on purpose. A regular account is anonymous by
-- design: we never ask for a name. It gets populated only when one exists -
-- from Google's profile on OAuth signup, or from the onboarding form an
-- organisation admin completes.
-- =====================================================================

alter table public.profiles
  add column email      text,
  add column full_name  text;

comment on column public.profiles.email is
  'Mirror of auth.users.email, kept in step by trigger. Not the source of truth.';
comment on column public.profiles.full_name is
  'Null for anonymous accounts. From Google metadata or org-admin onboarding.';

-- ---------------------------------------------------------------- creation
-- Extend the signup trigger so a new profile carries them from the start.
-- Google returns the display name as full_name, older payloads as name.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(
      coalesce(
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'name',
        ''
      ),
      ''
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ------------------------------------------------------------------- sync
-- Keeps the mirror honest when the auth record changes - an email change, or
-- a name arriving with a later OAuth sign-in. A name already stored is not
-- overwritten with null, so an org admin's submitted name survives a Google
-- payload that carries none.
create function public.sync_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email = new.email,
         full_name = coalesce(
           nullif(
             coalesce(
               new.raw_user_meta_data ->> 'full_name',
               new.raw_user_meta_data ->> 'name',
               ''
             ),
             ''
           ),
           full_name
         )
   where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_updated
  after update of email, raw_user_meta_data on auth.users
  for each row execute function public.sync_profile_from_auth();

-- --------------------------------------------------- org admin onboarding
-- The name an organisation admin types during onboarding belongs on the
-- profile too. It cannot be written by the client - profiles has no UPDATE
-- policy, deliberately, so nobody can reach user_type - so a trigger carries
-- it across instead.
create function public.sync_profile_from_org_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set full_name = coalesce(nullif(new.full_name, ''), full_name)
   where id = new.user_id;
  return new;
end;
$$;

create trigger org_admin_details_sync_profile
  after insert or update of full_name on public.org_admin_details
  for each row execute function public.sync_profile_from_org_admin();

-- --------------------------------------------------------------- backfill
update public.profiles p
   set email = u.email,
       full_name = coalesce(
         p.full_name,
         nullif(
           coalesce(
             u.raw_user_meta_data ->> 'full_name',
             u.raw_user_meta_data ->> 'name',
             ''
           ),
           ''
         )
       )
  from auth.users u
 where u.id = p.id;

-- Names already collected from organisation admins.
update public.profiles p
   set full_name = coalesce(p.full_name, d.full_name)
  from public.org_admin_details d
 where d.user_id = p.id;
