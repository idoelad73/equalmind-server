-- =====================================================================
-- 003  Organisation-admin onboarding details
--
-- Run after 002, in the Supabase SQL editor. Forward-only.
--
-- Accepting an invitation is no longer just "set a password". The invited
-- admin completes the full onboarding form - their own details, their
-- organisation's details, and optionally an employee list - and that is what
-- this table stores.
--
-- Division of responsibility:
--   organizations      what WE verified before inviting. Canonical.
--   org_admins         who administers which organisation. Granted by us.
--   org_admin_details  what the ADMIN declared at onboarding.
--
-- The last one is deliberately separate rather than overwriting
-- organizations: the admin's submission is a claim we may want to review
-- against what we verified, not an edit to the verified record.
-- =====================================================================

create table public.org_admin_details (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  organization_id  uuid references public.organizations (id) on delete set null,

  -- פרטי מנהל/ת המערכת
  full_name        text not null,
  mobile           text not null,
  contact_email    text not null,

  -- פרטי הארגון/הלקוח
  org_name         text not null,
  org_address      text,
  industry         text not null,
  company_number   text,
  employee_count   integer check (employee_count is null or employee_count >= 0),
  extra_notes      text,

  -- Optional employee CSV in the private employee-lists bucket (migration 001):
  -- { bucket, path, name, size }. Third-party personal data, so it is never
  -- placed on the media CDN alongside report photos.
  employee_list    jsonb,

  completed_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.org_admin_details is
  'Onboarding form submitted by an invited organisation admin. Their claim, not our verified record.';

create index org_admin_details_organization_idx
  on public.org_admin_details (organization_id);

create trigger org_admin_details_touch_updated_at
  before update on public.org_admin_details
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Row level security
--
-- Unlike organizations and org_admins - which only we may write - this table
-- IS filled in by the user, so it needs insert and update policies. They are
-- scoped to the caller's own row, and the row must belong to someone we have
-- already made an org admin: an ordinary user cannot create one.
-- =====================================================================

alter table public.org_admin_details enable row level security;

create policy org_admin_details_select_own on public.org_admin_details
  for select using (auth.uid() = user_id);

create policy org_admin_details_insert_own on public.org_admin_details
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.org_admins a where a.user_id = auth.uid())
  );

create policy org_admin_details_update_own on public.org_admin_details
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No DELETE policy.
