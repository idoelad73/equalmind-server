-- =====================================================================
-- The community-space behaviour catalogue, from the product screens.
--
-- Three changes:
--
-- 1. A category_order column. Until now the API ordered categories by
--    category_key, which is alphabetical and therefore arbitrary - the
--    cards appeared as municipal / infrastructure / public / sexist,
--    which is not the order the product puts them in. Display order is a
--    product decision, so it gets a column rather than falling out of how
--    a slug happens to sort.
--
-- 2. "אין מספיק צל כאן" moves from תשתיות פיזיות to מרחבים ציבוריים.
--    It was seeded from a screen that showed the behaviour without its
--    category; the full list puts it under public spaces.
--
-- 3. The remaining behaviours, including two categories that did not
--    exist here yet: שירותים עירוניים and סקסיסטי.
--
-- Re-runnable: every insert is ON CONFLICT DO UPDATE against the
-- (space, lower(name)) unique index, so a behaviour that already exists
-- is re-filed rather than duplicated.
-- =====================================================================

alter table public.behaviors
  add column if not exists category_order integer not null default 0;

comment on column public.behaviors.category_order is
  'Display order of the category card. Lower first. Same value on every row of a category.';

-- ------------------------------------------------------------ categories
update public.behaviors set category_order = 10 where category_key = 'public_spaces';
update public.behaviors set category_order = 20 where category_key = 'physical_infrastructure';
update public.behaviors set category_order = 30 where category_key = 'municipal_services';
update public.behaviors set category_order = 40 where category_key = 'sexist_content';

-- --------------------------------------------------------- the catalogue
insert into public.behaviors
  (space, category_key, category_label, category_order, name, sort_order)
values
  -- מרחבים ציבוריים
  ('community', 'public_spaces', 'מרחבים ציבוריים', 10,
   'המגרש כאן תפוס תמיד על ידי הבנים', 10),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 10,
   'השלטים כאן בלשון זכר/גבר בלבד', 20),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 10,
   'אין מספיק צל כאן', 30),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 10,
   'תחנת האוטובוס מוצבת במקום חשוך ומפחיד', 40),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 10,
   'נדרש/ת להמתין המון זמן להיכנס לשירותים', 50),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 10,
   'העירו לי הערות מיניות ופוגעניות כשעברתי שם', 60),
  ('community', 'public_spaces', 'מרחבים ציבוריים', 10,
   'באיזור הזה, אין תאורה מספקת בשעות החשיכה וזה מפחיד', 70),

  -- תשתיות פיזיות
  ('community', 'physical_infrastructure', 'תשתיות פיזיות', 20,
   'אין מספיק ספסלי ישיבה כאן', 10),
  ('community', 'physical_infrastructure', 'תשתיות פיזיות', 20,
   'המדרכות מקשות על הליכה עם עגלת תינוק', 20),

  -- שירותים עירוניים
  ('community', 'municipal_services', 'שירותים עירוניים', 30,
   'הטפסים כאן הם בלשון זכר/גבר בלבד', 10),
  ('community', 'municipal_services', 'שירותים עירוניים', 30,
   'התחבורה לא נוחה ויעילה לצרכים שלי', 20),

  -- סקסיסטי
  ('community', 'sexist_content', 'סקסיסטי', 40,
   'תמונות/פרסום סקסיסטיים', 10)

-- The unique index is on the expression (space, lower(name)), so the
-- conflict target has to be written the same way.
on conflict (space, lower(name)) do update
  set category_key   = excluded.category_key,
      category_label = excluded.category_label,
      category_order = excluded.category_order,
      sort_order     = excluded.sort_order,
      is_active      = true;

-- The ordering index should match how the API actually reads the table.
drop index if exists public.behaviors_space_idx;
create index behaviors_space_idx
  on public.behaviors (space, category_order, category_key, sort_order)
  where is_active;
