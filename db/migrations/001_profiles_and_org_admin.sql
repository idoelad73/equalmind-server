-- =====================================================================
-- 001  Account types and organisation-admin registration
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- auth.users stays the single identity table for every account. Supabase
-- will not accept new columns on it, so account attributes live in
-- public.profiles - one row per UID, created automatically by a trigger.
-- That is a 1:1 extension of auth.users, not a second user table.
--
-- Registration is ONE signup call. The client passes the whole form through
-- auth.signUp options.data, which lands in raw_user_meta_data, and the
-- trigger below fans it out into profiles and org_admin_details.
--
-- SECURITY, the part that matters:
-- raw_user_meta_data is writable by the client that holds the session, so
-- it can carry a REQUEST but never a GRANT. The trigger always creates the
-- profile as 'regular' and never reads a type from metadata. An org admin
-- registration is stored with status 'pending'; only an approval performed
-- by the service role promotes user_type to 'org_admin'.
-- =====================================================================

create type public.user_type as enum ('regular', 'org_admin');
create type public.org_admin_status as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  user_type   public.user_type not null default 'regular',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Account attributes for an auth user, 1:1 by UID. Identity plane - never joined to reports.';
comment on column public.profiles.user_type is
  'Service-role writable only. Never set from client metadata.';

-- ------------------------------------------------------- org_admin_details
create table public.org_admin_details (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references auth.users (id) on delete cascade,

  -- פרטי מנהל/ת המערכת
  full_name         text not null,
  mobile            text not null,
  contact_email     text not null,

  -- פרטי הארגון/הלקוח
  org_name          text not null,
  org_address       text,
  industry          text not null,
  company_number    text,
  employee_count    integer check (employee_count is null or employee_count >= 0),
  extra_notes       text,

  -- Optional employee CSV: { bucket, path, name, size } in Supabase Storage.
  -- Employee lists are third-party personal data, so they are NOT stored on
  -- the media CDN alongside report photos.
  employee_list     jsonb,

  status            public.org_admin_status not null default 'pending',
  reviewed_at       timestamptz,
  reviewed_by       uuid references auth.users (id),
  rejection_reason  text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.org_admin_details is
  'Organisation registration submitted at signup, awaiting review.';

create index org_admin_details_status_idx on public.org_admin_details (status);

-- ------------------------------------------------------------- the fan-out
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  -- Always 'regular'. The type is deliberately not read from metadata.
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;

  if meta ->> 'requested_type' = 'org_admin' then
    -- A request with missing mandatory fields is a malformed client, not a
    -- half-valid registration: fail the signup loudly rather than leave an
    -- account with no organisation attached.
    if coalesce(meta ->> 'full_name', '') = ''
       or coalesce(meta ->> 'mobile', '') = ''
       or coalesce(meta ->> 'org_name', '') = ''
       or coalesce(meta ->> 'industry', '') = '' then
      raise exception 'org_admin registration is missing mandatory fields';
    end if;

    insert into public.org_admin_details (
      user_id, full_name, mobile, contact_email,
      org_name, org_address, industry, company_number, employee_count, extra_notes
    )
    values (
      new.id,
      meta ->> 'full_name',
      meta ->> 'mobile',
      coalesce(nullif(meta ->> 'contact_email', ''), new.email),
      meta ->> 'org_name',
      nullif(meta ->> 'org_address', ''),
      meta ->> 'industry',
      nullif(meta ->> 'company_number', ''),
      nullif(meta ->> 'employee_count', '')::integer,
      nullif(meta ->> 'extra_notes', '')
    )
    on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------ updated_at
create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger org_admin_details_touch_updated_at
  before update on public.org_admin_details
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Approval. Service role only - there is no policy that lets a user
-- reach profiles.user_type, so this is the single promotion path.
-- =====================================================================
create function public.approve_org_admin(target uuid, reviewer uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.org_admin_details
     set status = 'approved', reviewed_at = now(), reviewed_by = reviewer
   where user_id = target and status = 'pending';

  if not found then
    raise exception 'no pending organisation registration for %', target;
  end if;

  update public.profiles set user_type = 'org_admin' where id = target;
end;
$$;

revoke all on function public.approve_org_admin(uuid, uuid) from public, anon, authenticated;

-- =====================================================================
-- Row level security
--
-- The anon key is public and ships in the browser bundle, so RLS is the
-- only thing between a visitor and these tables.
-- =====================================================================

alter table public.profiles enable row level security;
alter table public.org_admin_details enable row level security;

-- Read your own profile. No INSERT policy (the trigger creates the row) and
-- deliberately no UPDATE policy, so user_type cannot be self-assigned.
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

-- Read your own organisation registration.
create policy org_admin_select_own on public.org_admin_details
  for select using (auth.uid() = user_id);

-- Correct your own submission while it is still pending - this is also how
-- the optional employee CSV reference is attached after signup. Once a
-- reviewer has acted, the row becomes read-only to the user.
create policy org_admin_update_own_pending on public.org_admin_details
  for update
  using (auth.uid() = user_id and status = 'pending')
  with check (auth.uid() = user_id and status = 'pending');

-- No INSERT policy: rows are created by the trigger, in the same
-- transaction as the signup. No DELETE policy.

-- =====================================================================
-- Private bucket for employee lists
--
-- These CSVs hold names, phones and emails of people who are not the
-- uploader, so they get their own private bucket rather than the media CDN.
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('employee-lists', 'employee-lists', false)
on conflict (id) do nothing;

-- A user may write and read only within a folder named after their own UID.
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
