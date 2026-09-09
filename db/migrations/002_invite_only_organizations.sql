-- =====================================================================
-- 002  Invite-only organisations
--
-- Run after 001, in the Supabase SQL editor. Forward-only.
--
-- WHY THIS REPLACES SELF-REGISTRATION
-- An org admin sees the reports belonging to their organisation, so a
-- fraudulent one could be the very person those reports are about. No
-- automated check on a public form is worth that risk, so there is no
-- public path to org_admin at all:
--
--   1. Equalmind verifies the organisation off-platform
--   2. Staff create the organizations row
--   3. Staff invite the admin by email (service role only)
--   4. The invite itself is the authority
--
-- The public form survives as a LEAD. It creates no account and grants
-- nothing - see org_registration_requests.
--
-- Note what is NOT here: the trigger no longer reads an organisation from
-- signup metadata. Metadata is client-writable, so anyone could have passed
-- an organization_id and promoted themselves. Instead the invite script
-- writes membership directly with the service role, using the user id that
-- inviteUserByEmail returns. There is nothing left to forge.
-- =====================================================================

-- --------------------------------------------------------- organizations
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

-- ------------------------------------------------------------ org_admins
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
-- link to auth.users. Someone reads it and decides whether to verify.
drop table if exists public.org_admin_details;

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

-- --------------------------------------------------------- updated_at
create trigger organizations_touch_updated_at
  before update on public.organizations
  for each row execute function public.touch_updated_at();

create trigger org_admins_touch_updated_at
  before update on public.org_admins
  for each row execute function public.touch_updated_at();

create trigger org_registration_requests_touch_updated_at
  before update on public.org_registration_requests
  for each row execute function public.touch_updated_at();

-- ============================================================
-- The signup trigger goes back to doing one thing.
--
-- It no longer reads organisation details or a requested type from
-- raw_user_meta_data. Every new account - invited or self-registered -
-- starts as a regular profile, and only the invite script promotes it.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Approval-after-the-fact is gone: authority is granted at invite time.
drop function if exists public.approve_org_admin(uuid, uuid);

-- ============================================================
-- Row level security
-- ============================================================
alter table public.organizations             enable row level security;
alter table public.org_admins                enable row level security;
alter table public.org_registration_requests enable row level security;

-- An org admin may read their own organisation, and only that one.
create policy organizations_select_own on public.organizations
  for select using (
    exists (
      select 1 from public.org_admins a
       where a.user_id = auth.uid()
         and a.organization_id = organizations.id
    )
  );

-- An org admin may read their own membership row.
create policy org_admins_select_own on public.org_admins
  for select using (auth.uid() = user_id);

-- Deliberately no INSERT or UPDATE policy on either table: membership is
-- granted by the service role at invite time and by nothing else.

-- No policies at all on org_registration_requests. The anon key cannot
-- read or write it; submissions arrive through the API with the service
-- role, so the queue cannot be scraped or spammed directly.
