-- =====================================================================
-- The "do not message twice" rule applies to invitations, not to
-- everything.
--
-- 016 made (roster_id, kind) unique for every kind. The intent was that
-- the bulk notify must not invite the same person twice - but the index
-- as written also meant a second test send to the same roster row was
-- rejected by the database, and worse, that every real send after the
-- first one had nowhere to be recorded.
--
-- An audit trail that refuses the second entry is not an audit trail.
-- The constraint now covers roster invitations only; every other kind is
-- free to accumulate rows, which is what a log is for.
-- =====================================================================

drop index if exists public.sms_outbox_roster_kind_key;

create unique index sms_outbox_roster_invite_key
  on public.sms_outbox (roster_id)
  where roster_id is not null and kind = 'roster_invite';

comment on index public.sms_outbox_roster_invite_key is
  'One invitation per roster member. Other kinds (test, future notifications) are unconstrained on purpose.';
