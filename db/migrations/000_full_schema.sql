-- =====================================================================
-- Equalmind - complete schema, for a fresh Supabase project
--
-- Paste this whole file into the SQL editor and run it once.
--
-- This is migrations 001-004 and 007 collapsed into their end state.
-- 005 (a local mirror of the data.gov.il registries) and 006 (its
-- rollback) cancel out and are deliberately absent: organisation lookup
-- proxies data.gov.il through the API instead of storing 800k rows.
--
-- THE TWO RULES THE WHOLE DESIGN RESTS ON
--
-- 1. auth.users is the single identity table. Supabase will not accept
--    new columns on it, so account attributes live in public.profiles,
--    one row per UID, created automatically by a trigger.
--
-- 2. user_type is NEVER read from client metadata. Metadata is writable
--    by whoever holds the session, so anyone could promote themselves.
--    Organisation admins are granted by the invite script, service role
--    only. profiles has no UPDATE policy for end users at all.
-- =====================================================================

create type public.user_type as enum ('regular', 'org_admin');
create type public.org_admin_status as enum ('pending', 'approved', 'rejected');

-- ------------------------------------------------------------ utilities
create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  user_type            public.user_type not null default 'regular',

  email                text,
  full_name            text,

  -- Self-declared workplace. Optional, unverified, grants nothing.
  org_registry_id      text,
  org_registry_source  text check (org_registry_source in ('companies', 'nonprofits')),
  org_name             text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.profiles is
  'Account attributes for an auth user, 1:1 by UID. Identity plane - never joined to reports.';
comment on column public.profiles.user_type is
  'Service-role writable only. Never set from client metadata.';
comment on column public.profiles.email is
  'Mirror of auth.users.email, kept in step by trigger. Not the source of truth.';

-- ----------------------------------------------------------- organizations
create table public.organizations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  industry        text,
  company_number  text,
  address         text,
  employee_count  integer check (employee_count is null or employee_count >= 0),
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.organizations is
  'A verified organisation. Created by staff after off-platform verification, never by self-service.';

create unique index organizations_name_key on public.organizations (lower(name));

-- -------------------------------------------------------------- org_admins
create table public.org_admins (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  full_name        text,
  mobile           text,
  contact_email    text,

  invited_by       uuid references auth.users (id),
  invited_at       timestamptz not null default now(),
  activated_at     timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.org_admins is
  'Which user administers which organisation. Written by the service role at invite time.';

create index org_admins_organization_idx on public.org_admins (organization_id);

-- ------------------------------------------- org_registration_requests
-- The public form. A lead, not a credential: no account, no access, no
-- link to auth.users.
create table public.org_registration_requests (
  id              uuid primary key default gen_random_uuid(),

  full_name       text not null,
  mobile          text not null,
  contact_email   text not null,

  org_name        text not null,
  org_address     text,
  industry        text not null,
  company_number  text,
  employee_count  integer check (employee_count is null or employee_count >= 0),
  extra_notes     text,

  status          public.org_admin_status not null default 'pending',
  handled_at      timestamptz,
  handled_by      uuid references auth.users (id),
  handling_notes  text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.org_registration_requests is
  'Inbound interest from the public form. Grants nothing.';

create index org_registration_requests_status_idx
  on public.org_registration_requests (status);

-- --------------------------------------------------------- org_admin_details
-- What the invited admin declared during onboarding. Deliberately separate
-- from organizations: their submission is a claim we may want to review
-- against what we verified, not an edit to the verified record.
create table public.org_admin_details (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  organization_id  uuid references public.organizations (id) on delete set null,

  full_name        text not null,
  mobile           text not null,
  contact_email    text not null,

  org_name         text not null,
  org_address      text,
  industry         text not null,
  company_number   text,
  employee_count   integer check (employee_count is null or employee_count >= 0),
  extra_notes      text,

  registry_id      text,
  registry_source  text check (registry_source in ('companies', 'nonprofits')),

  -- Optional employee CSV in the private employee-lists bucket:
  -- { bucket, path, name, size }. Third-party personal data, so never on
  -- the media CDN alongside report photos.
  employee_list    jsonb,

  completed_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.org_admin_details is
  'Onboarding form submitted by an invited organisation admin. Their claim, not our verified record.';

create index org_admin_details_organization_idx
  on public.org_admin_details (organization_id);

-- =====================================================================
-- Triggers
-- =====================================================================

-- Every new auth user gets a profile, always 'regular'. The affiliation
-- fields DO come from metadata, which is fine: an affiliation is a claim
-- about oneself, not a permission.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, email, full_name, org_registry_id, org_registry_source, org_name)
  values (
    new.id,
    new.email,
    nullif(coalesce(meta ->> 'full_name', meta ->> 'name', ''), ''),
    nullif(meta ->> 'org_registry_id', ''),
    nullif(meta ->> 'org_registry_source', ''),
    nullif(meta ->> 'org_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keeps the mirrored email and name honest when the auth record changes.
-- A stored name is never overwritten with null, so an org admin's typed
-- name survives a later Google sign-in that carries none.
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
           nullif(coalesce(new.raw_user_meta_data ->> 'full_name',
                           new.raw_user_meta_data ->> 'name', ''), ''),
           full_name
         )
   where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_updated
  after update of email, raw_user_meta_data on auth.users
  for each row execute function public.sync_profile_from_auth();

-- The name an org admin types during onboarding belongs on the profile too.
-- It cannot be written by the client, since profiles has no UPDATE policy.
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

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger organizations_touch_updated_at
  before update on public.organizations
  for each row execute function public.touch_updated_at();
create trigger org_admins_touch_updated_at
  before update on public.org_admins
  for each row execute function public.touch_updated_at();
create trigger org_registration_requests_touch_updated_at
  before update on public.org_registration_requests
  for each row execute function public.touch_updated_at();
create trigger org_admin_details_touch_updated_at
  before update on public.org_admin_details
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Row level security
--
-- The anon key is public and ships in the browser bundle, so RLS is the
-- only thing between a visitor and these tables.
-- =====================================================================

alter table public.profiles                  enable row level security;
alter table public.organizations             enable row level security;
alter table public.org_admins                enable row level security;
alter table public.org_registration_requests enable row level security;
alter table public.org_admin_details         enable row level security;

-- Read your own profile. No INSERT (the trigger creates it) and
-- deliberately no UPDATE, so user_type cannot be self-assigned. The
-- affiliation is changed through the API with the service role.
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

-- An org admin may read their own organisation, and only that one.
create policy organizations_select_own on public.organizations
  for select using (
    exists (
      select 1 from public.org_admins a
       where a.user_id = auth.uid() and a.organization_id = organizations.id
    )
  );

create policy org_admins_select_own on public.org_admins
  for select using (auth.uid() = user_id);

-- org_admin_details IS filled in by the user, so it needs insert and update.
-- Both scoped to their own row, and insert requires them to already be an
-- org admin: an ordinary user cannot create one.
create policy org_admin_details_select_own on public.org_admin_details
  for select using (auth.uid() = user_id);

create policy org_admin_details_insert_own on public.org_admin_details
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.org_admins a where a.user_id = auth.uid())
  );

create policy org_admin_details_update_own on public.org_admin_details
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No policies at all on org_registration_requests: the anon key cannot read
-- or write it. Submissions arrive through the API with the service role, so
-- the queue cannot be scraped or spammed directly.

-- =====================================================================
-- Private bucket for employee lists
--
-- These CSVs hold names, phones and emails of people who are not the
-- uploader, so they get their own private bucket rather than the media CDN.
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('employee-lists', 'employee-lists', false)
on conflict (id) do nothing;

create policy employee_lists_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'employee-lists'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy employee_lists_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'employee-lists'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
