-- =====================================================================
-- One identity per organisation.
--
-- Before this migration an organisation could be named four ways:
--
--   organizations.id              uuid, the real key
--   organizations.company_number  text, NULLABLE and NOT UNIQUE
--   organizations.name            text, unique on lower(name)
--   profiles.org_registry_id      text, no foreign key to anything
--
-- and the only thing joining a reporter to an organisation was a string
-- comparison between the last two. Three things were wrong with that:
--
-- 1. company_number had no unique constraint, so the join could match
--    more than one organisation. reports.controller.js took the first
--    row, which meant reports about identifiable people could route to
--    an arbitrary organisation, differently on each call.
--
-- 2. The two sides are written by different code paths. org_registry_id
--    comes from the registry API and is clean digits; company_number was
--    typed by hand - the CLI flag, a CSV column, or a free-text field on
--    the onboarding form. "51-234567" never matches "51234567", so the
--    report silently got no organisation at all.
--
-- 3. Nothing linked a profile to an organisation, so every consumer had
--    to redo the string join and could get a different answer.
--
-- After this migration there is exactly one answer to "which organisation
-- is this": organizations.id, reached through organizations.registry_id,
-- which is normalised and unique. profiles.organization_id holds the
-- resolved pointer and is maintained by trigger, so no caller ever joins
-- on text again.
-- =====================================================================

-- ------------------------------------------------------- normalisation
-- Registry numbers arrive as "512345678", "51-234567", " 580123456 ".
-- Only the digits are the number.
create function public.normalize_registry_id(value text)
returns text language sql immutable as $$
  select nullif(regexp_replace(coalesce(value, ''), '\D', '', 'g'), '')
$$;

comment on function public.normalize_registry_id(text) is
  'Digits only. Every registry number in this database passes through here before it is stored or compared.';

-- --------------------------------------------- organizations: the key
alter table public.organizations
  add column registry_id      text,
  add column registry_source  text check (registry_source in ('companies', 'nonprofits'));

update public.organizations
   set registry_id = public.normalize_registry_id(company_number)
 where company_number is not null;

-- Israeli registration numbers are self-describing: עמותות are allocated
-- the 58 block, companies 51-57. Enough to backfill the source for rows
-- that predate the column.
update public.organizations
   set registry_source = case when registry_id like '58%' then 'nonprofits' else 'companies' end
 where registry_id is not null and registry_source is null;

-- Fail loudly rather than silently dropping a duplicate. If this raises,
-- two organisation rows share a registration number: merge them by hand,
-- repoint org_admins / org_admin_details / reports, then re-run.
do $$
declare
  dupes text;
begin
  select string_agg(format('%s (%s rows)', registry_id, n), ', ')
    into dupes
    from (
      select registry_id, count(*) as n
        from public.organizations
       where registry_id is not null
       group by registry_id
      having count(*) > 1
    ) d;

  if dupes is not null then
    raise exception 'Duplicate registry numbers in public.organizations: %. Merge these rows before running this migration.', dupes;
  end if;
end $$;

create unique index organizations_registry_id_key
  on public.organizations (registry_id)
  where registry_id is not null;

comment on column public.organizations.registry_id is
  'THE canonical registry number, digits only. Unique. This is what a profile resolves through.';

-- company_number is gone: keeping a second copy is what allowed the two
-- to diverge in the first place.
alter table public.organizations drop column company_number;

-- Normalise on the way in, so nothing can insert an unnormalised number.
create function public.normalize_organization_registry()
returns trigger language plpgsql as $$
begin
  new.registry_id := public.normalize_registry_id(new.registry_id);
  return new;
end;
$$;

create trigger organizations_normalize_registry
  before insert or update of registry_id on public.organizations
  for each row execute function public.normalize_organization_registry();

-- -------------------------------------------- profiles: the resolved id
alter table public.profiles
  add column organization_id uuid references public.organizations (id) on delete set null;

comment on column public.profiles.organization_id is
  'Resolved pointer to a VERIFIED organisation, or null. Maintained by trigger - never written by hand. Grants nothing on its own.';
comment on column public.profiles.org_registry_id is
  'What the user declared, normalised. Kept even when it resolves to nothing: most workplaces have no organisations row yet.';

create index profiles_organization_idx on public.profiles (organization_id)
  where organization_id is not null;

create function public.resolve_organization_id(p_registry_id text)
returns uuid language sql stable as $$
  select o.id
    from public.organizations o
   where o.registry_id = public.normalize_registry_id(p_registry_id)
     and o.is_active
$$;

comment on function public.resolve_organization_id(text) is
  'Registry number to organisation id. Safe to return a single row because organizations_registry_id_key makes it unique.';

create function public.sync_profile_organization()
returns trigger language plpgsql as $$
begin
  new.org_registry_id := public.normalize_registry_id(new.org_registry_id);
  new.organization_id := public.resolve_organization_id(new.org_registry_id);
  return new;
end;
$$;

create trigger profiles_sync_organization
  before insert or update of org_registry_id on public.profiles
  for each row execute function public.sync_profile_organization();

-- The other direction. An employee usually declares a workplace long
-- before that organisation is verified, so linking only at declaration
-- time would leave them permanently unlinked. When an organisation
-- appears, everyone who already named it is attached.
create function public.relink_profiles_to_organization()
returns trigger language plpgsql as $$
begin
  if new.is_active then
    update public.profiles
       set organization_id = new.id
     where org_registry_id = new.registry_id
       and organization_id is distinct from new.id;
  else
    -- Deactivated: detach, so reports stop routing to it.
    update public.profiles
       set organization_id = null
     where organization_id = new.id;
  end if;
  return new;
end;
$$;

create trigger organizations_relink_profiles
  after insert or update of registry_id, is_active on public.organizations
  for each row execute function public.relink_profiles_to_organization();

-- ------------------------------------------------------------- backfill
update public.profiles
   set org_registry_id = public.normalize_registry_id(org_registry_id)
 where org_registry_id is not null;

update public.profiles p
   set organization_id = public.resolve_organization_id(p.org_registry_id)
 where p.org_registry_id is not null;

-- Reports filed before this migration resolved through the old string
-- join; re-resolve them through the profile so old and new agree.
update public.reports r
   set organization_id = p.organization_id
  from public.profiles p
 where r.user_id = p.id
   and r.organization_id is distinct from p.organization_id;

-- ------------------------------------ org_admin_details: the same number twice
-- This table carried company_number (a free-text field on the onboarding
-- form) alongside registry_id (the value the registry picker produced).
-- Both meant "the registration number", and the form let an admin edit one
-- of them, so a row could contradict itself with no way to tell which half
-- was right. registry_id wins: it is the value that came from the registry.
update public.org_admin_details
   set registry_id = public.normalize_registry_id(coalesce(registry_id, company_number));

update public.org_admin_details
   set registry_source = case when registry_id like '58%' then 'nonprofits' else 'companies' end
 where registry_id is not null and registry_source is null;

alter table public.org_admin_details drop column company_number;

comment on column public.org_admin_details.registry_id is
  'THE registration number the admin declared, digits only. Compare against organizations.registry_id when reviewing.';
