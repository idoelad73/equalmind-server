-- =====================================================================
-- Let an invited admin submit the registration form before any
-- organisation exists.
--
-- Invitations now carry no organisation: the invitee declares it on the
-- form. But org_admin_details_insert_own required an org_admins row,
-- which is only written once an organisation exists - so the invitee hit
-- an RLS failure on the one insert the whole onboarding depends on.
--
-- The check moves to profiles.user_type, which is exactly as safe. Both
-- are service-role-only: profiles has no INSERT or UPDATE policy for end
-- users at all, so user_type cannot be self-assigned any more than an
-- org_admins row could be self-inserted.
-- =====================================================================

drop policy org_admin_details_insert_own on public.org_admin_details;

create policy org_admin_details_insert_own on public.org_admin_details
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and p.user_type = 'org_admin'
    )
  );
