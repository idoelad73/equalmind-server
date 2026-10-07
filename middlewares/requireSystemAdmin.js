import { query } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'

/**
 * Gate for anything only Equalmind's own staff may reach. Runs after
 * `requireAuth`.
 *
 * The role is read from `profiles` with the service role, never from a token
 * claim or request body - the same rule as requireOrgAdmin, and for the same
 * reason: metadata is writable by whoever holds the session, so a role taken
 * from it is a role anyone can grant themselves. `profiles` has no UPDATE
 * policy for end users, which is what makes this check meaningful.
 *
 * Deliberately not a superset of requireOrgAdmin. A system admin belongs to
 * Equalmind and has no organisation, so it cannot stand in for one - an
 * endpoint scoped to "your organisation" has nothing to scope to here.
 */
export async function requireSystemAdmin(req, _res, next) {
  const { rows } = await query(
    `select 1 from public.profiles where id = $1 and user_type = 'system_admin'`,
    [req.user.id],
  )

  if (!rows.length) {
    throw AppError.forbidden('הדף הזה זמין לצוות Equalmind בלבד.')
  }

  next()
}
