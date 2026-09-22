-- =====================================================================
-- Store the phone number on the roster.
--
-- org_rosters kept only phone_hash, so a roster could be matched but
-- never read back. This adds the number itself, in E.164, alongside the
-- hash - the hash stays, and it is still what a claim looks up.
--
-- WHAT THIS CHANGES, PLAINLY: the table now holds plaintext numbers of
-- people who have not signed up and have not agreed to anything. Anyone
-- with the service role key, a database dump or a backup has the list.
-- That was the exact exposure phone_hash existed to remove, so treat
-- org_rosters as personal data from here on: it is no longer safe to
-- share a dump of it the way it was yesterday.
-- =====================================================================

alter table public.org_rosters add column phone text;

comment on column public.org_rosters.phone is
  'E.164, as supplied by the employer. Plaintext third-party personal data - see the header of this migration.';

comment on column public.org_rosters.phone_hash is
  'HMAC of the number. Still the matching key, so a claim never needs the plaintext.';

-- Rows imported before this column existed keep a null phone: there is no
-- plaintext to recover from a hash. Re-uploading the same file fills them
-- in, since an existing row is updated rather than duplicated.
