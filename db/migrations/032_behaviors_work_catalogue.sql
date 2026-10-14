-- =====================================================================
-- 032  The work-space behaviour catalogue, from the product screens.
--
-- Run in the Supabase SQL editor. Forward-only: no down migration.
--
-- מרחב עבודה had no rows at all, so step one of the wizard offered only
-- the custom Hook form. This seeds it the way 020 seeded community and
-- 031 seeded consumption: same columns, same ordering rules, same
-- conflict handling.
--
-- Six categories, in the order the product shows them. category_order is
-- repeated on every row of a category because that is how the API reads
-- it - see behaviors_space_idx at the end of 020.
--
--   10  ישיבות ודיונים      12 behaviours
--   20  אחד/ת על אחד/ת      12
--   30  המרחב הפיזי          4
--   40  תרבות ארגונית        6
--   50  עבודה בשטח           3
--   60  התנהלות כללית        8
--                           --
--                           45
--
-- UNLIKE THE OTHER TWO SPACES, this list mixes behaviours that are good
-- with behaviours that are not: 'מקשיב/ה בעיון לדברים שאמרתי בישיבה' sits
-- beside 'קוטע/ת אותי באמצע דברים'. That is how the product screens have
-- it, and it is why nothing in the schema calls these complaints. If the
-- alert engine ever needs to tell the two apart, that is a new column on
-- behaviors, not an assumption read into the wording.
--
-- Three near-identical rows about credit are deliberate and distinct:
--   'לוקח/ת קרדיט על רעיונות שהעליתי'  (ישיבות ודיונים)
--   'נוטל/ת קרדיט על רעיונות שהעליתי'  (התנהלות כללית)
--   'נותן/ת לי קרדיט על רעיונות שהעליתי' (התנהלות כללית)
-- The first two differ only in verb, the third is the opposite meaning.
-- The unique index is on (space, lower(name)), so all three coexist.
--
-- THE KEYS ARE NEW, so client/src/pages/SpacePage.jsx needs an icon for
-- each or the cards fall back to the generic Tag.
--
-- Re-runnable: every insert is ON CONFLICT DO UPDATE against the
-- (space, lower(name)) unique index, so a behaviour that already exists
-- is re-filed rather than duplicated.
-- =====================================================================

insert into public.behaviors
  (space, category_key, category_label, category_order, name, sort_order)
values
  -- ------------------------------------------------ ישיבות ודיונים
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'לוקח/ת קרדיט על רעיונות שהעליתי', 10),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'מספר/ת בדיחות סקסיסטיות בתחילת כל ישיבה', 20),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'מסביר/ה אותי בלי שביקשתי', 30),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'מתעלם/ת מהדברים שאני אומר/ת בישיבות', 40),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'מעלה/ת נושאים לא קשורים בישיבה', 50),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'מדבר/ת בטלפון או מסתכל/ת במחשב בזמן שאני מדבר/ת', 60),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'שואל/ת אותי שאלות רלוונטיות שמעמיקות את הדיון', 70),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'נותן/ת לי לסיים את המשפטים שלי בישיבה', 80),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'מציע/ה פתרונות יצירתיים למסקנות שאמרתי', 90),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'קוטע/ת אותי באמצע דברים', 100),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'מקשיב/ה בעיון לדברים שאמרתי בישיבה', 110),
  ('work', 'meetings', 'ישיבות ודיונים', 10,
   'תומך/ת ברעיונות שהעליתי בישיבה', 120),

  -- ------------------------------------------------ אחד/ת על אחד/ת
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'כל הזמן מספר לי את הטעם שלו בנשים.', 10),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'בוהה באיברים האינטימיים שלי', 20),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'מתעניין/ת בדעתי ובהצעות שלי לשיפור', 30),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'מעניק/ה לי תשומת לב מלאה בשיחות פרטיות', 40),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'מזלזל/ת בי בנוכחות לקוחות או גורמים חיצוניים', 50),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'מסתכל/ת במחשב או בטלפון בזמן שיחה פרטית', 60),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'לא מתעניין/ת בדעתי או בהרגשות שלי', 70),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'נותן/ת לי משוב שלילי או ביקורת לא בונה', 80),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'נותן/ת לי משוב בונה על הביצועים שלי', 90),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'לא מכין/ה אותי לפגישות חשובות עם לקוחות', 100),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'שואל/ת על הרגשות שלי ועל הצרכים שלי בעבודה', 110),
  ('work', 'one_on_one', 'אחד/ת על אחד/ת', 20,
   'מתעלם/ת מהדעות שלי בפגישות עם לקוחות', 120),

  -- --------------------------------------------------- המרחב הפיזי
  ('work', 'physical_space', 'המרחב הפיזי', 30,
   'התמונות בכל מקום מזכירות גברים', 10),
  ('work', 'physical_space', 'המרחב הפיזי', 30,
   'גזרת המדים לא מתאימה לנשים', 20),
  ('work', 'physical_space', 'המרחב הפיזי', 30,
   'הציוד כבד מדי או לא ממש מתאים לי', 30),
  ('work', 'physical_space', 'המרחב הפיזי', 30,
   'שירותי הנשים תמיד תפוסים או רחוקים מאוד', 40),

  -- ------------------------------------------------- תרבות ארגונית
  ('work', 'org_culture', 'תרבות ארגונית', 40,
   'יוצר/ת סביבה כלולה ונעימה לכולם', 10),
  ('work', 'org_culture', 'תרבות ארגונית', 40,
   'מעודד/ת גיוון דעות ונקודות מבט שונות', 20),
  ('work', 'org_culture', 'תרבות ארגונית', 40,
   'מקדם/ת שוויון הזדמנויות לכל העובדים', 30),
  ('work', 'org_culture', 'תרבות ארגונית', 40,
   'מעדיף/ה עובדים מסוימים על פני אחרים ללא הצדקה מקצועית', 40),
  ('work', 'org_culture', 'תרבות ארגונית', 40,
   'משתמש/ת בהומור או בהערות שפוגעות בקבוצות מסוימות', 50),
  ('work', 'org_culture', 'תרבות ארגונית', 40,
   'יוצר/ת אווירה מדירה או לא נוחה למינויים מסוימים', 60),

  -- ---------------------------------------------------- עבודה בשטח
  ('work', 'field_work', 'עבודה בשטח', 50,
   'תומך/ת בי ונותן/ת לי לבטא את הדעות שלי מול לקוחות', 10),
  ('work', 'field_work', 'עבודה בשטח', 50,
   'מתייחס/ת אליי בכבוד בנוכחות לקוחות', 20),
  ('work', 'field_work', 'עבודה בשטח', 50,
   'מכבד/ת את המומחיות שלי בפני גורמים חיצוניים', 30),

  -- ------------------------------------------------- התנהלות כללית
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'מתייעץ/ת איתי לפני קבלת החלטות הנוגעות לתחום שלי', 10),
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'נותן/ת לי קרדיט על רעיונות שהעליתי', 20),
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'נוטל/ת קרדיט על רעיונות שהעליתי', 30),
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'מחזיר/ת לי מיילים ומודיע/ה כשמשימות הושלמו', 40),
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'מקבל/ת החלטות בתחום שלי בלי לייעץ איתי', 50),
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'מכבד/ת את הזמן שלי ומגיע/ה בזמן לפגישות', 60),
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'מאחר/ת לפגישות או מבטל/ת אותן ברגע האחרון', 70),
  ('work', 'general_conduct', 'התנהלות כללית', 60,
   'לא מחזיר/ת מיילים או לא מעדכן/ת על התקדמות', 80)

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
--    where space = 'work' and is_active
--    group by 1, 2, 3
--    order by 1;
--   -- expect 10 meetings 12, 20 one_on_one 12, 30 physical_space 4,
--   --        40 org_culture 6, 50 field_work 3, 60 general_conduct 8
--   -- 45 rows in total
