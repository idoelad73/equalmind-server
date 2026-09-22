-- =====================================================================
-- The invitation message, declared at onboarding.
--
-- organizations.invite_sms_template (018) is the live value. This column
-- is what the admin typed on the registration form, which activation
-- copies across - the same split as every other field on that form:
-- org_admin_details is their claim, organizations is the record.
--
-- Keeping the declaration separately means a later edit to the live
-- template does not erase what was originally agreed to, which matters
-- when the question is "what did we tell this company we would send".
-- =====================================================================

alter table public.org_admin_details
  add column invite_sms_template text;

comment on column public.org_admin_details.invite_sms_template is
  'Invitation SMS text as declared at onboarding. Copied to organizations.invite_sms_template on activation.';

-- Same ceiling as organizations: 280 characters is four Hebrew segments,
-- and a template longer than that is a mistake rather than a decision.
alter table public.org_admin_details
  add constraint org_admin_details_invite_template_length
  check (invite_sms_template is null or char_length(invite_sms_template) <= 280);
