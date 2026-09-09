-- =====================================================================
-- 006  Roll back 005 (local registry mirror)
--
-- Run after 005, in the Supabase SQL editor. Forward-only.
--
-- WHY 005 WAS REVERSED
-- Mirroring both data.gov.il registries meant ~806,000 rows plus two GIN
-- trigram indexes - realistically 300-500 MB once built. Supabase's free
-- tier allows 500 MB, so one autocomplete used a handful of times a week
-- during organisation onboarding would have consumed the entire database
-- allowance.
--
-- Company lookup now proxies data.gov.il directly, with a short in-memory
-- cache on our side. No rows stored, no import job, never stale.
--
-- WHEN TO BRING THE MIRROR BACK
--   - the database moves off the free tier and disk stops mattering
--   - lookups become frequent rather than occasional
--   - registry data needs JOINing against our own tables (for example,
--     flagging that a reported organisation is מחוקה) - a proxy cannot do
--     that
--   - data.gov.il proves unreliable in practice
-- =====================================================================

drop table if exists public.companies_registry;

-- Name normalisation moves to the server (lib/normalizeOrgName.js), where the
-- comparison now happens. One implementation, in the language that uses it.
drop function if exists public.normalize_org_name(text);

-- Nothing else uses it. Re-adding is a one-liner if the mirror ever returns.
drop extension if exists pg_trgm;
