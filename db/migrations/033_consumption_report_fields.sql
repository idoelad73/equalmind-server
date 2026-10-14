-- =====================================================================
-- 033  The consumption-space report: a business, not a town
--
-- Run in the Supabase SQL editor, after 032. Renumbered from 030, which was already taken by
-- 030_sms_opt_out.sql - that one is applied, this one was not. Forward-only.
--
-- In מרחב הצריכה the thing a report is about is a BUSINESS, so that form
-- asks for one (required) instead of a locality. It reuses the "about whom"
-- columns migration 023 added for custom Hooks:
--
--   target_type = 'business'   target_name = the business's name
--
-- and adds what that form asks for beyond them:
--
--   business_address  the picked business's address from the search, so two
--                     branches of one chain stay distinguishable
--   staff_name        the representative / employee who served them
--                     (optional). Names a person: like target_name, NEVER
--                     returned to an org admin.
--   place_text        "איפה פיזית זה קרה?" - free text such as "בקופה"
--
-- locality_name stays as it is (nullable since 028). When the business is
-- picked from the search, its town is stored there, so the aggregate "where"
-- picture still fills in without asking the reporter for it twice.
-- =====================================================================

alter table public.reports
  add column business_address text check (business_address is null or length(business_address) <= 200),
  add column staff_name       text check (staff_name is null or length(staff_name) <= 120),
  add column place_text       text check (place_text is null or length(place_text) <= 200);

comment on column public.reports.business_address is
  'Consumption space: address of the business picked from the search, if any.';
comment on column public.reports.staff_name is
  'Consumption space: who served the reporter. May name a person - never returned to an org admin.';
comment on column public.reports.place_text is
  'Consumption space: where inside/around the business it happened, free text.';

-- ------------------------------------------------------------ verify
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'reports'
--      and column_name in ('business_address', 'staff_name', 'place_text');
--   -- expect three rows
