-- =====================================================================
-- 025  A custom Hook carries a category, and approval can promote it
--
-- Run in the Supabase SQL editor, AFTER 023 and 024. Forward-only.
--
-- Approving a proposed Hook in the review queue now inserts it into
-- public.behaviors. A behaviors row needs a category, which the custom
-- form did not ask for, so the form now does - and the report keeps the
-- answer until a reviewer acts on it:
--
--   category_key    an existing category of that space, or
--   category_label  the name of a new one the reporter proposed ("אחר")
--
-- At most one of the two is set. Both null is a Hook filed before this
-- migration; the reviewer picks a category for it at approval.
--
-- messages.behavior_id records which catalogue row an approval created
-- (or reactivated), so the queue can show what came of each proposal.
-- =====================================================================

alter table public.reports
  add column category_key   text,
  add column category_label text
    check (category_label is null or length(category_label) <= 80),
  add constraint reports_one_category
    check (category_key is null or category_label is null);

comment on column public.reports.category_key is
  'Custom Hooks only: the existing behaviors.category_key the reporter chose.';
comment on column public.reports.category_label is
  'Custom Hooks only: a new category the reporter proposed. Becomes a category when approved.';

alter table public.messages
  add column behavior_id uuid references public.behaviors (id) on delete set null;

comment on column public.messages.behavior_id is
  'The catalogue row an approval created or reactivated. Null until approved.';

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select table_name, column_name from information_schema.columns
--    where table_schema = 'public'
--      and (table_name, column_name) in (('reports', 'category_key'),
--                                        ('reports', 'category_label'),
--                                        ('messages', 'behavior_id'));
--   -- expect three rows
