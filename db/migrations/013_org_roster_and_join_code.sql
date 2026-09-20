-- =====================================================================
-- Attaching a regular user to their organisation.
--
-- Two ways in, in order of authority:
--
--   1. roster   the org admin uploaded a list; the employee's phone
--               number matched it
--   2. code     the employee typed the organisation's join code
--   3. declared the employee picked a workplace on their profile
--
-- A roster or code link is something the organisation asserted. A
-- declaration is only a claim about oneself, so it must never overwrite
-- one of the first two. profiles.org_source records which it was.
--
-- WHY THE PHONE NUMBER, AND WHY ONLY A HASH
--
-- A name cannot identify an account: registration is email and password,
-- and profiles.full_name is null for every email signup. A phone number
-- is unique, the employer already has it, and it is what SMS will need
-- later.
--
-- But a roster is a list of people who have NOT signed up and never
-- agreed to anything. So org_rosters stores only an HMAC of the number,
-- computed with a secret that lives in the server environment and never
-- in this database. Holding the database gives you no phone numbers.
--
-- The plaintext number lands in exactly one place - profiles.phone -
-- and only once that person has typed it in themselves.
-- =====================================================================

-- ------------------------------------------------- how a profile got linked
alter table public.profiles
  add column org_source text check (org_source in ('roster', 'code', 'declared')),
  add column phone      text;

comment on column public.profiles.org_source is
  'How organization_id was set. roster/code are asserted by the organisation and outrank a self-declaration.';
comment on column public.profiles.phone is
  'E.164, supplied by the user themselves. The roster never stores a plaintext number - only this column does.';

-- One account per number. Without this, two accounts could claim the same
-- roster row and both be attached.
create unique index profiles_phone_key on public.profiles (phone)
  where phone is not null;

-- Existing rows were all linked by declaration.
update public.profiles set org_source = 'declared' where organization_id is not null;

-- ------------------------------------------------------------- the roster
create table public.org_rosters (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  -- HMAC-SHA256(E.164 number, ROSTER_HASH_SECRET), hex. Never reversible
  -- from this database alone.
  phone_hash       text not null,

  -- Optional, and third-party personal data: this is a person who has not
  -- signed up. Kept only so an admin can recognise their own list.
  employee_name    text,

  added_by         uuid references auth.users (id),
  added_at         timestamptz not null default now(),

  claimed_at       timestamptz,
  claimed_by       uuid references auth.users (id) on delete set null
);

comment on table public.org_rosters is
  'Employee lists uploaded by org admins, keyed by a hash of the phone number. No plaintext numbers.';

-- Global, not per-organisation: one person works at one organisation, and
-- a second upload of the same number should fail loudly rather than
-- silently move someone between employers.
create unique index org_rosters_phone_hash_key on public.org_rosters (phone_hash);
create index org_rosters_organization_idx on public.org_rosters (organization_id);

alter table public.org_rosters enable row level security;
-- No policies: the anon key cannot read or write it. Imports and claims
-- both go through the API with the service role.

-- ---------------------------------------------------------- the join code
-- For anyone the roster misses - someone who signed up before their
-- employer uploaded a list, or whose number the employer does not have.
alter table public.organizations
  add column join_code          text,
  add column join_code_set_at   timestamptz;

create unique index organizations_join_code_key on public.organizations (join_code)
  where join_code is not null;

comment on column public.organizations.join_code is
  'Shared secret an employee can type to attach themselves. Rotatable: rotating orphans nothing, since links already made are kept.';

-- ------------------------------------------------------- precedence rules
-- Replaces the version from migration 012, which overwrote organization_id
-- from the declared registry number unconditionally.
create or replace function public.sync_profile_organization()
returns trigger language plpgsql as $$
begin
  new.org_registry_id := public.normalize_registry_id(new.org_registry_id);

  -- The organisation asserted this link. A self-declaration does not
  -- get to overrule it.
  if coalesce(new.org_source, '') in ('roster', 'code') then
    return new;
  end if;

  new.organization_id := public.resolve_organization_id(new.org_registry_id);
  new.org_source := case when new.organization_id is null then null else 'declared' end;
  return new;
end;
$$;

-- Same change in the other direction: when an organisation appears, only
-- attach the people who declared it. Roster and code links already point
-- where they should.
create or replace function public.relink_profiles_to_organization()
returns trigger language plpgsql as $$
begin
  if new.is_active then
    update public.profiles
       set organization_id = new.id,
           org_source = 'declared'
     where org_registry_id = new.registry_id
       and coalesce(org_source, 'declared') = 'declared'
       and organization_id is distinct from new.id;
  else
    -- Deactivated: detach everyone, however they were linked, so reports
    -- stop routing to it.
    update public.profiles
       set organization_id = null,
           org_source = null
     where organization_id = new.id;
  end if;
  return new;
end;
$$;
