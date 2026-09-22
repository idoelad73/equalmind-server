-- =====================================================================
-- Per-organisation invitation text.
--
-- The wording of a message sent to someone's employees is content, not
-- configuration: it gets reworded during a pilot, it differs per client,
-- and whoever wants it changed is not the person with shell access.
--
-- So it lives here rather than in an environment variable. A column is
-- editable from the Supabase table editor, needs no deploy and no
-- restart, and holds newlines without escaping - which an env var does
-- not. Null means "use the default in lib/smsProvider.js".
--
-- Placeholders, substituted at send time:
--
--   {org}  the organisation's name
--   {url}  SMS_INVITE_URL
--
-- LENGTH IS COST. Hebrew is UCS-2, so a segment is 70 characters, not
-- 160. Every 70 characters added here multiplies across the whole
-- roster, and the API reports the segment count before sending so the
-- bill is visible before it is incurred.
-- =====================================================================

alter table public.organizations
  add column invite_sms_template text;

comment on column public.organizations.invite_sms_template is
  'Invitation SMS body. Placeholders {org} and {url}. Null uses the built-in default. Hebrew costs a segment per 70 chars.';

-- A guard against the accident that costs money: a template long enough
-- to be several segments per recipient is almost always a mistake rather
-- than a decision. 280 characters is four Hebrew segments.
alter table public.organizations
  add constraint organizations_invite_template_length
  check (invite_sms_template is null or char_length(invite_sms_template) <= 280);
