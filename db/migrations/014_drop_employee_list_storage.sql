-- =====================================================================
-- Remove the employee-list column and its storage policies.
--
-- Onboarding used to upload the employee CSV as a file: names and phone
-- numbers of people who had not signed up, in plaintext, sitting in a
-- storage bucket, with a pointer in org_admin_details.employee_list.
--
-- That is precisely the thing migration 013 was written to avoid. The
-- roster now parses the file, stores an HMAC of each number and discards
-- the rest, so keeping a plaintext copy of the same data would have
-- undone the whole exercise - a private bucket is still a bucket.
--
-- Nothing reads either of these any more: the upload path was replaced in
-- lib/orgAdminApi.js with a POST to /api/org/roster.
--
-- THE BUCKET ITSELF IS NOT DROPPED HERE. Supabase blocks DELETE on
-- storage.buckets and storage.objects with a trigger
-- (storage.protect_delete), because removing the row would leave the
-- underlying files behind with nothing pointing at them. The bucket goes
-- through the Storage API instead, after this migration:
--
--   cd server
--   node scripts/drop-storage-bucket.mjs employee-lists
-- =====================================================================

drop policy if exists employee_lists_insert_own on storage.objects;
drop policy if exists employee_lists_select_own on storage.objects;

alter table public.org_admin_details drop column if exists employee_list;
