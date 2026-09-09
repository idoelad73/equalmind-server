-- =====================================================================
-- 007  Organisation affiliation from the registry
--
-- Run after 006, in the Supabase SQL editor. Forward-only.
--
-- Both registration paths can now attach an organisation chosen from the
-- data.gov.il registries:
--   regular users    optional - self-declared affiliation
--   org admins       mandatory - the organisation they administer
--
-- The registry id is stored alongside the name because the name alone is
-- ambiguous: the registries contain many near-identical names, and a user
-- who typed rather than selected gives us nothing to verify against.
-- =====================================================================

-- ------------------------------------------------------- regular accounts
alter table public.profiles
  add column org_registry_id      text,
  add column org_registry_source  text check (org_registry_source in ('companies', 'nonprofits')),
  add column org_name             text;

comment on column public.profiles.org_registry_id is
  'ח.פ or מספר עמותה from data.gov.il. Self-declared and unverified - an affiliation the user claims, not one we checked.';

-- ------------------------------------------------------ org admin details
alter table public.org_admin_details
  add column registry_id      text,
  add column registry_source  text check (registry_source in ('companies', 'nonprofits'));

comment on column public.org_admin_details.registry_id is
  'Registry number of the organisation selected during onboarding. Compare against organizations.company_number when reviewing.';

-- ============================================================
-- Carry the affiliation through signup.
--
-- These fields come from client metadata, which is fine here: an affiliation
-- is a claim someone makes about themselves, not a permission. user_type is
-- still never read from metadata - see 002.
-- ============================================================
create or replace function public.handle_new_user()
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
