/**
 * An organisation's people, as the "about whom" picker sees them.
 *
 * Reads public.org_workers (migration 027). Shared by the list endpoint and
 * by filing a Hook, so the rule for who may see whom lives in one place.
 */
import { query } from '../db/pool.js'

/**
 * Which organisation's people this user may look up, and how.
 *
 *   'full'    the employer asserted the link - matched by the uploaded
 *             roster, joined with the organisation's code, or administering
 *             it. Browses the whole list with department and job title.
 *   'search'  the user only DECLARED the workplace on their profile. Typed
 *             search only: names, at least SEARCH_MIN letters, at most
 *             SEARCH_LIMIT matches. Enough to find a colleague; copying the
 *             staff list - people who never signed up included - becomes slow
 *             and rate limited instead of one request.
 *
 * Returns { organizationId, mode } or null.
 */
export async function workerAccessFor(userId) {
  const { rows } = await query(
    `select
       coalesce(
         (select p.organization_id from public.profiles p
           where p.id = $1 and p.org_source in ('roster', 'code')),
         (select a.organization_id from public.org_admins a
           where a.user_id = $1)
       ) as asserted,
       (select p.organization_id from public.profiles p
         where p.id = $1 and p.org_source = 'declared') as declared`,
    [userId],
  )
  const { asserted, declared } = rows[0] ?? {}
  if (asserted) return { organizationId: asserted, mode: 'full' }
  if (declared) return { organizationId: declared, mode: 'search' }
  return null
}

export const SEARCH_MIN = 2
export const SEARCH_LIMIT = 10

/**
 * Names matching what the user typed, from the start of any word - typing
 * "כה" finds "דנה כהן". Names only, by design: this is the path a merely
 * declared user gets (workerAccessFor), so department and job title stay out.
 */
export async function searchWorkers(organizationId, term, excludeUserId) {
  // LIKE wildcards in the input are literal characters, not patterns.
  const safe = term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  const { rows } = await query(
    `select worker_id, full_name
       from public.org_workers
      where organization_id = $1
        and nullif(full_name, '') is not null
        and user_id is distinct from $3
        and (full_name ilike $2::text || '%' or full_name ilike '% ' || $2::text || '%')
      order by full_name
      limit ${SEARCH_LIMIT}`,
    [organizationId, safe, excludeUserId],
  )
  return rows.map((r) => ({ id: r.worker_id, fullName: r.full_name }))
}

/**
 * Everyone in the organisation except the caller. Names, department and
 * job title only - never a phone, and never the account id behind a row.
 */
export async function listWorkers(organizationId, excludeUserId) {
  const { rows } = await query(
    `select worker_id, full_name, department, job_title
       from public.org_workers
      where organization_id = $1
        and nullif(full_name, '') is not null
        and user_id is distinct from $2
      order by full_name
      limit 5000`,
    [organizationId, excludeUserId],
  )
  return rows.map((r) => ({
    id: r.worker_id,
    fullName: r.full_name,
    department: r.department,
    jobTitle: r.job_title,
  }))
}

/** One worker, only if they belong to that organisation. */
export async function findWorker(organizationId, workerId) {
  const { rows } = await query(
    `select worker_id, full_name from public.org_workers
      where organization_id = $1 and worker_id = $2
      limit 1`,
    [organizationId, workerId],
  )
  return rows[0] ?? null
}
