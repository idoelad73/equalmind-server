-- =====================================================================
-- The behaviour catalogue.
--
-- One row per selectable behaviour. The report wizard reads nothing but
-- this table, so the whole list is editable from the Supabase table
-- editor without a deploy.
--
-- category_key alongside category_label on purpose: the label is Hebrew
-- copy that will be reworded, while the key is what the client maps to an
-- icon and what any later analytics groups by. Rewording a label must not
-- silently change which icon appears or break a saved grouping.
-- =====================================================================

create table public.behaviors (
  id              uuid primary key default gen_random_uuid(),

  -- Matches SPACES[].key in client/src/lib/spaces.js.
  space           text not null check (space in ('work', 'community', 'consumption')),

  category_key    text not null,
  category_label  text not null,
  name            text not null,

  sort_order      integer not null default 0,
  is_active       boolean not null default true,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.behaviors is
  'Selectable behaviours for the report wizard. Catalogue data, not user data.';
comment on column public.behaviors.category_key is
  'Stable slug. The client maps it to an icon; category_label is display copy and may change.';

create index behaviors_space_idx on public.behaviors (space, category_key, sort_order)
  where is_active;

create unique index behaviors_space_name_key
  on public.behaviors (space, lower(name));

create trigger behaviors_touch_updated_at
  before update on public.behaviors
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------- RLS
-- Catalogue, not user data: any signed-in user may read it, nobody may
-- write it. Edits happen in the dashboard with the service role.
alter table public.behaviors enable row level security;

create policy behaviors_select_active on public.behaviors
  for select to authenticated
  using (is_active);

-- ------------------------------------------------------------------ seed
-- Only the behaviours visible in the supplied screens. The full list still
-- has to come from the product side - inventing report categories for a
-- live product would put words in real reporters' mouths.
insert into public.behaviors (space, category_key, category_label, name, sort_order) values
  ('community', 'public_spaces', 'מרחבים ציבוריים', 'נדרש/ת להמתין המון זמן להיכנס לשירותים', 10),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 'העירו לי הערות מיניות ופוגעניות כשעברתי שם', 20),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 'באיזור הזה, אין תאורה מספקת בשעות החשיכה וזה מפחיד', 30),
  ('community', 'physical_infrastructure', 'תשתיות פיזיות', 'אין מספיק ספסלי ישיבה כאן', 10),
  ('community', 'physical_infrastructure', 'תשתיות פיזיות', 'אין מספיק צל כאן', 20);
