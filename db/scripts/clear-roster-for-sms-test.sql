-- Clear the uploaded employee roster, to re-run the SMS invitation test.
--
-- NOT a migration. Run it in the Supabase SQL editor.
--
-- WHAT THIS CANNOT DO: delete a user. A roster row is a name and a phone
-- number the employer uploaded - a person who has NOT signed up and has no
-- account. Accounts live in auth.users and public.profiles, and neither is
-- named anywhere below. The system admin, the org admin and anyone who
-- registered themselves are untouched because they were never in here.
--
-- The guards are what make that true however the data changes later:
--
--   claimed_at is null   A claimed row is the employer's assertion behind
--                        a real account's organisation link. Deleting it
--                        would leave that profile pointing at an employer
--                        with nothing backing the claim. Such a row is
--                        skipped, not deleted.
--
--   registry_id          Scoped to one organisation, so this can never
--                        empty another company's roster by accident.
--                        511251217 is אמדוקס.


-- ---------------------------------------------------------------- step 0
-- What would go, before anything goes. Run this on its own first.

select r.employee_name,
       left(r.phone, 7) || '***' || right(r.phone, 3) as phone,
       r.added_at,
       r.invited_at is not null as was_invited,
       r.claimed_at is not null as claimed_so_kept
  from public.org_rosters r
  join public.organizations o on o.id = r.organization_id
 where o.registry_id = '511251217'
 order by r.added_at;


-- ---------------------------------------------------------------- step 1
-- Delete the unclaimed roster rows.

delete from public.org_rosters r
 using public.organizations o
 where o.id = r.organization_id
   and o.registry_id = '511251217'
   and r.claimed_at is null;


-- ---------------------------------------------------------------- step 2
-- OPTIONAL: clear the SMS log for this organisation.
--
-- Not needed to re-run the test. sms_outbox.roster_id is ON DELETE SET
-- NULL, so step 1 already detached those rows and the partial unique index
-- on (roster_id, kind) stops blocking a fresh send.
--
-- Only run this if you want the delivery history gone as well. It is the
-- record of which real phone numbers were messaged and whether it worked -
-- the thing to read when a send goes wrong, and the only evidence that a
-- message was ever sent to a given person.

-- delete from public.sms_outbox s
--  using public.organizations o
--  where o.id = s.organization_id
--    and o.registry_id = '511251217'
--    and s.kind = 'roster_invite';


-- ---------------------------------------------------------------- step 3
-- Confirm: the roster is empty and every account is still there.

select count(*)::int as roster_rows_left
  from public.org_rosters r
  join public.organizations o on o.id = r.organization_id
 where o.registry_id = '511251217';

select u.email, p.user_type, p.org_source
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.created_at;
-- expect all three accounts, unchanged.
