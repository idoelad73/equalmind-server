-- =====================================================================
-- 030  A working opt-out for invitation SMS.
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- Until now the invitation said 'להסרה השיבו "הסר"' and nothing read
-- replies: no inbound handler, no list, no check before sending. Israel's
-- Communications Law s.30A requires the opt-out to be offered AND
-- honoured - up to NIS 1,000 per message, no proof of damage needed - so
-- the line was a liability rather than a safeguard.
--
-- A LINK instead of a reply, because SMS4Free's free tier has no inbound
-- channel at all. A reply-based opt-out cannot be honoured on this plan
-- however carefully it is worded; a link can.
--
-- TWO PIECES:
--
--   org_rosters.opt_out_token  a per-person random string, the only thing
--                              the link carries. Not the phone number, not
--                              the hash, nothing derivable - a URL ends up
--                              in logs, histories and screenshots.
--
--   sms_opt_outs               who asked to stop. Keyed by the SAME HMAC
--                              the roster uses, so this table is NOT a
--                              second list of real phone numbers, and an
--                              opt-out survives the roster row being
--                              deleted and re-uploaded. That outliving is
--                              the point: a suppression list that a
--                              re-import clears is not a suppression list.
-- =====================================================================

-- ------------------------------------------------------------- the token
alter table public.org_rosters
  add column opt_out_token text unique;

-- 16 bytes, base64. Trimmed of padding and made URL-safe, because every
-- character is paid for: a Hebrew SMS carries 70 characters per segment,
-- and this string sits inside a link inside the message.
update public.org_rosters
   set opt_out_token = translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_')
 where opt_out_token is null;

alter table public.org_rosters
  alter column opt_out_token set default translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_'),
  alter column opt_out_token set not null;

comment on column public.org_rosters.opt_out_token is
  'Random. The only thing the opt-out link carries - never the number or its hash. Rotate it by setting it to the default again.';

-- --------------------------------------------------------- the list
create table public.sms_opt_outs (
  -- HMAC-SHA256 of the E.164 number under ROSTER_HASH_SECRET, exactly as
  -- org_rosters.phone_hash. Same key, so a check costs one lookup - and
  -- this table is useless to anyone who holds it without the secret.
  phone_hash   text primary key,

  opted_out_at timestamptz not null default now(),

  -- 'link' today. Room for 'reply' or 'manual' without a migration, since
  -- however it arrives the answer is the same: stop.
  source       text not null default 'link'
                 check (source in ('link', 'reply', 'manual')),

  -- Which organisation's message prompted it. For understanding later,
  -- never for scoping the suppression: somebody who says stop means stop,
  -- not "stop except from my next employer".
  organization_id uuid references public.organizations (id) on delete set null
);

comment on table public.sms_opt_outs is
  'People who asked not to receive invitation SMS. Checked before every send. GLOBAL, not per organisation. Never delete a row to resume sending.';

-- RLS on with no policies: the anon key cannot reach it, and the opt-out
-- endpoint is public, so it must go through the server with the service
-- role rather than from the browser.
alter table public.sms_opt_outs enable row level security;

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select count(*) filter (where opt_out_token is null) as missing_tokens,
--          count(distinct opt_out_token) = count(*)      as all_unique
--     from public.org_rosters;
--   -- expect 0, true
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public' and tablename = 'sms_opt_outs';
--   -- expect one row, rowsecurity true
