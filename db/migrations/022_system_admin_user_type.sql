-- =====================================================================
-- 022  system_admin: Equalmind's own staff
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- A third account type alongside 'regular' and 'org_admin'. It belongs to
-- Equalmind, not to any organisation, so it has no org_admins row and no
-- organization_id of its own.
--
-- This migration DEFINES the type and the one path that grants it. It
-- grants no access: no RLS policy mentions system_admin, so a system admin
-- reaches the database exactly as far as a regular user does. Whatever
-- they are allowed to do goes through the API, checked server-side, the
-- same way requireOrgAdmin checks org_admin.
--
-- Same rule as org_admin: the type is never read from client metadata, and
-- profiles has no UPDATE policy, so nobody can promote themselves.
--
-- NOTE: `alter type ... add value` cannot be USED in the transaction that
-- adds it, and the SQL editor runs this file as one transaction. Nothing
-- below compares against the new value at run time - the function body is
-- only parsed when called - so this is safe to run as a single script.
-- =====================================================================

alter type public.user_type add value if not exists 'system_admin';

comment on column public.profiles.user_type is
  'regular | org_admin | system_admin. Service-role writable only. Never set from client metadata.';

-- ------------------------------------------------------------- the grant
-- Service role only, like approve_org_admin. Refuses to turn an org admin
-- into a system admin silently: those are different people with different
-- reach, and one account holding both would blur who saw what.
create function public.grant_system_admin(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_type public.user_type;
begin
  select user_type into current_type from public.profiles where id = target;

  if not found then
    raise exception 'no profile for %', target;
  end if;

  if current_type = 'org_admin' then
    raise exception '% is an org admin - use a separate account for Equalmind staff', target;
  end if;

  update public.profiles set user_type = 'system_admin' where id = target;
end;
$$;

revoke all on function public.grant_system_admin(uuid) from public, anon, authenticated;

create function public.revoke_system_admin(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set user_type = 'regular'
   where id = target and user_type = 'system_admin';

  if not found then
    raise exception '% is not a system admin', target;
  end if;
end;
$$;

revoke all on function public.revoke_system_admin(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ verify
-- Run separately, after the script above has committed:
--
--   select unnest(enum_range(null::public.user_type));
--   -- expect: regular, org_admin, system_admin
--
--   select proname from pg_proc
--    where proname in ('grant_system_admin', 'revoke_system_admin');
