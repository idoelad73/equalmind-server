-- =====================================================================
-- Every SMS the system sends, recorded.
--
-- Two reasons this exists before any real provider does.
--
-- 1. The mock driver needs somewhere to put a message. A demo where the
--    message only reaches a server log is not a demo.
--
-- 2. Israel's Anti-Spam Law allows statutory damages of up to NIS 1,000
--    per message with no proof of damage. If anyone ever claims we
--    messaged them, the only useful answer is a row showing what was
--    sent, when, to which number, and on whose instruction. Adding this
--    after the first real send would be too late for exactly the
--    messages most likely to be disputed.
-- =====================================================================

create table public.sms_outbox (
  id               uuid primary key default gen_random_uuid(),

  -- 'mock' until a real driver is configured. Recorded per message, not
  -- read from config at display time: which provider sent a given message
  -- is a fact about that message.
  provider         text not null,
  kind             text not null,

  phone            text not null,
  body             text not null,

  -- Who the message was about and who caused it to be sent.
  organization_id  uuid references public.organizations (id) on delete set null,
  roster_id        uuid references public.org_rosters (id) on delete set null,
  requested_by     uuid references auth.users (id) on delete set null,

  status           text not null default 'queued'
                     check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider_ref     text,
  error            text,

  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);

comment on table public.sms_outbox is
  'Audit trail of outbound SMS. Holds plaintext numbers and message bodies - treat as personal data.';
comment on column public.sms_outbox.provider is
  'Which driver actually sent it. "mock" means nothing left the server.';

create index sms_outbox_organization_idx on public.sms_outbox (organization_id, created_at desc);
create index sms_outbox_phone_idx on public.sms_outbox (phone, created_at desc);

-- One invitation per roster row. A second attempt updates rather than
-- inserts, so a double-clicked button cannot message somebody twice.
create unique index sms_outbox_roster_kind_key
  on public.sms_outbox (roster_id, kind)
  where roster_id is not null;

alter table public.sms_outbox enable row level security;
-- No policies: the anon key cannot read or write it. Everything goes
-- through the API with the service role.

-- ------------------------------------------------- who has been invited
-- Kept on the roster so the admin's list can show it without joining the
-- outbox, and so a re-upload of the same CSV does not look like a reason
-- to message someone again.
alter table public.org_rosters
  add column invited_at timestamptz;

comment on column public.org_rosters.invited_at is
  'When a registration invitation was last sent to this person, if ever.';
