import { query } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'

/**
 * Gate for anything only an organisation admin may reach. Runs after
 * `requireAuth` and attaches `req.orgAdmin = { organizationId }`.
 *
 * The organisation comes from `org_admins`, read here with the service role -
 * never from the request. A client that could name its own organisation could
 * read another organisation's reports, which are about identifiable people.
 *
 * Both conditions are checked, not either: `profiles.user_type` says the
 * account holds the role, `org_admins` says which organisation it holds it
 * for. An account with the type but no membership row has nothing to read.
 */
export async function requireOrgAdmin(req, _res, next) {
  const { rows } = await query(
    `select a.organization_id
       from public.profiles p
       join public.org_admins a on a.user_id = p.id
      where p.id = $1 and p.user_type = 'org_admin'`,
    [req.user.id],
  )

  if (!rows.length) {
    throw AppError.forbidden('הדף הזה זמין למנהל.ת מערכת ארגונית בלבד.')
  }

  req.orgAdmin = { organizationId: rows[0].organization_id }
  next()
}
