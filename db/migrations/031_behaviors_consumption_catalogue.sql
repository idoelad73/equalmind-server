-- =====================================================================
-- 031  The consumption-space behaviour catalogue, from the product screens.
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- מרחב צריכה had no rows at all, so the wizard's first step showed
-- "עדיין אין התנהגויות במרחב צריכה" and the only way forward was the
-- custom Hook form. This seeds it the same way 020 seeded community:
-- same columns, same ordering rules, same conflict handling.
--
-- Three categories, in the order the product shows them. category_order
-- is repeated on every row of a category because that is how the API
-- reads it - see the behaviors_space_idx at the end of 020.
--
--   10  סביבת החנות
--   20  נגישות מוצרים
--   30  שירות לקוחות
--
-- THE KEYS ARE NEW, so client/src/pages/SpacePage.jsx needs an icon for
-- each or the category cards fall back to the generic Tag. That mapping
-- is keyed on category_key, never on the Hebrew label, so rewording a
-- label here cannot silently change an icon.
--
-- Re-runnable: every insert is ON CONFLICT DO UPDATE against the
-- (space, lower(name)) unique index, so a behaviour that already exists
-- is re-filed rather than duplicated.
-- =====================================================================

insert into public.behaviors
  (space, category_key, category_label, category_order, name, sort_order)
values
  -- סביבת החנות
  ('consumption', 'store_environment', 'סביבת החנות', 10,
   'החניון הזה מפחיד', 10),
  ('consumption', 'store_environment', 'סביבת החנות', 10,
   'אין חדר החתלה/חדר ההחתלה הוא בשירותי הנשים', 20),

  -- נגישות מוצרים
  ('consumption', 'product_access', 'נגישות מוצרים', 20,
   'אין כאן מידות לנשים גדולות', 10),

  -- שירות לקוחות
  ('consumption', 'customer_service', 'שירות לקוחות', 30,
   'המוכר/ת צועק/ת על הנשים כל הזמן', 10)

-- The unique index is on the expression (space, lower(name)), so the
-- conflict target has to be written the same way.
on conflict (space, lower(name)) do update
  set category_key   = excluded.category_key,
      category_label = excluded.category_label,
      category_order = excluded.category_order,
      sort_order     = excluded.sort_order,
      is_active      = true;

-- ------------------------------------------------------------ verify
-- Run separately afterwards:
--
--   select category_order, category_key, category_label, count(*)::int
--     from public.behaviors
--    where space = 'consumption' and is_active
--    group by 1, 2, 3
--    order by 1;
--   -- expect 10 store_environment 2, 20 product_access 1,
--   --        30 customer_service 1
