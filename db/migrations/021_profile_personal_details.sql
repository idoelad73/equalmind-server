-- =====================================================================
-- Personal details collected at registration.
--
-- Place of residence is required by the form; the rest are optional. All
-- of them are claims a person makes about themselves, so they arrive in
-- signup metadata and the trigger copies them - the same route the
-- workplace affiliation already takes, and for the same reason: an
-- affiliation or an address is not a permission.
--
-- NOTE ON ANONYMITY. Until now an account was an email address and
-- nothing else, and the register page says so: "אפשר להשתמש בכתובת
-- שאינה מזהה אותך". A name, a phone number and a street address together
-- identify a person completely. They are optional, and the form says so,
-- but profiles is now meaningfully more sensitive than it was.
-- =====================================================================

alter table public.profiles
  add column residence_locality_code text,
  add column residence_locality_name text,
  add column address                 text,
  add column gender                  text
    check (gender in ('male', 'female', 'not_relevant'));

comment on column public.profiles.residence_locality_name is
  'Place of residence, chosen from the CBS locality list. Required by the registration form.';
comment on column public.profiles.gender is
  'Self-declared. not_relevant is a real answer, not a missing one - null means they did not say.';

create index profiles_residence_idx on public.profiles (residence_locality_code)
  where residence_locality_code is not null;

-- ------------------------------------------------- phone, in one format
-- profiles.phone is unique and is what a roster hash is matched against,
-- so a number typed as "050-123-4567" at signup has to land the same way
-- as one claimed later through the API. The API normalises in
-- lib/phone.js; this is the same rule in SQL, for the trigger path.
--
-- MUST MATCH lib/phone.js normalizePhone(). Mobiles only: 05X + 7 digits.
create function public.normalize_phone_il(value text)
returns text language sql immutable as $$
  with digits as (
    select regexp_replace(coalesce(value, ''), '\D', '', 'g') as d
  ),
  no_country as (
    select case
             when d like '00972%' then substr(d, 6)
             when d like '972%'   then substr(d, 4)
             else d
           end as d
      from digits
  ),
  no_trunk as (
    select case when d like '0%' then substr(d, 2) else d end as d from no_country
  )
  select case when d ~ '^5[0-9][0-9]{7}$' then '+972' || d else null end from no_trunk
$$;

comment on function public.normalize_phone_il(text) is
  'Israeli mobile to E.164, or null. Mirrors lib/phone.js - change both together.';

-- ------------------------------------------------------------- trigger
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta    jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_phone text  := public.normalize_phone_il(meta ->> 'phone');
begin
  -- profiles.phone is unique. A number already claimed by another account
  -- is dropped rather than allowed to fail the insert: this trigger runs
  -- inside the auth.users insert, so raising here would abort the signup
  -- with an error the person cannot act on. They can set it later from
  -- their profile, where the conflict is reported properly as a 409.
  if v_phone is not null
     and exists (select 1 from public.profiles where phone = v_phone) then
    v_phone := null;
  end if;

  insert into public.profiles (
    id, email, full_name, phone, address, gender,
    residence_locality_code, residence_locality_name,
    org_registry_id, org_registry_source, org_name
  )
  values (
    new.id,
    new.email,
    nullif(coalesce(meta ->> 'full_name', meta ->> 'name', ''), ''),
    v_phone,
    nullif(meta ->> 'address', ''),
    nullif(meta ->> 'gender', ''),
    nullif(meta ->> 'residence_locality_code', ''),
    nullif(meta ->> 'residence_locality_name', ''),
    nullif(meta ->> 'org_registry_id', ''),
    nullif(meta ->> 'org_registry_source', ''),
    nullif(meta ->> 'org_name', '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
