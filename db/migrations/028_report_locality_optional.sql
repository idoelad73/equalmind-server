-- The locality stops being mandatory on a report.
--
-- 010 made locality_name NOT NULL on the reasoning that the alert engine
-- cannot work without knowing where something happened. That is still true
-- of the aggregate picture, and the catalogue form still asks for it - but
-- it is the wrong trade on the custom Hook form, which is the one people
-- reach when what happened does not fit any of the prepared wording.
-- Somebody describing something they cannot place should not be stopped
-- by the form. A report that is awkward to file does not get filed.
--
-- Nothing else changes: locality_code was already nullable, and the
-- partial index on it is unaffected.
--
-- Rollback is not free. Going back to NOT NULL means deciding what to do
-- with the rows that have no locality by then - they cannot be invented,
-- so they would have to be deleted or given a placeholder. Treat this as
-- one-way.

alter table public.reports
  alter column locality_name drop not null;

comment on column public.reports.locality_name is
  'Where it happened, as the reporter named it. Null is allowed: the custom '
  'Hook form does not require it. Denormalised like behavior_name - the '
  'wording shown at the time is kept even if the locality list changes.';
