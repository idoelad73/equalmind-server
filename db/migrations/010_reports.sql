-- =====================================================================
-- Reports.
--
-- NOTE: superseded in part by migration 011, which adds user_id and
-- organization_id. "Anonymous" in this product means anonymous to the
-- ORGANISATION, not to Equalmind. Read 011's header for the rule that
-- actually governs this table now.
--
-- What still holds from the original design:
--
-- RLS is enabled with no policies, so the anon key can neither read nor
-- write reports. Every read goes through the API, which names its columns
-- explicitly and never returns user_id to an org admin.
-- =====================================================================

create table public.reports (
  id              uuid primary key default gen_random_uuid(),

  space           text not null check (space in ('work', 'community', 'consumption')),

  -- restrict, not cascade: deleting a catalogue row must not silently
  -- delete the reports filed against it.
  behavior_id     uuid not null references public.behaviors (id) on delete restrict,

  -- Denormalised on purpose. A report is evidence about a moment, so it
  -- keeps the wording that was actually shown when it was filed, even
  -- after the catalogue is reworded.
  behavior_name   text not null,

  locality_code   text,
  locality_name   text not null,

  -- Two shapes because the form offers both: a picked timestamp, or the
  -- free text someone typed ("בשבוע שעבר").
  occurred_at     timestamptz,
  occurred_text   text,

  notes           text,

  -- Cloudinary publicId, never a URL. Links are minted on demand by
  -- mediaProvider.getSignedUrl.
  photo_public_id text,

  created_at      timestamptz not null default now()
);

comment on table public.reports is
  'Anonymous reports. Deliberately has no reference to auth.users - see the header of this migration.';
comment on column public.reports.behavior_name is
  'Wording shown at filing time. Kept even if the catalogue row is later reworded.';

create index reports_space_created_idx on public.reports (space, created_at desc);
create index reports_locality_idx on public.reports (locality_code) where locality_code is not null;

-- ------------------------------------------------------------------- RLS
-- Enabled with no policies at all: the anon key can neither read nor
-- write reports. Every insert goes through the API with the service role,
-- so a signed-in user cannot read back the table and correlate rows
-- against their own session.
alter table public.reports enable row level security;
