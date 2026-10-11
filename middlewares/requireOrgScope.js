import { query } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'

/**
 * Resolve which organisation this request acts on, and attach it as
 * `req.orgAdmin = { organizationId, actingAsStaff }`.
 *
 * Two kinds of caller reach the same controllers, and the difference between
 * them is the whole point of this file:
 *
 *   org_admin     the organisation is THEIR OWN, read from org_admins. A
 *                 value in the request is ignored, not honoured - an admin
 *                 who could name an organisation could seed another
 *                 company's roster or read its reports.
 *
 *   system_admin  Equalmind staff have no organisation of their own, so they
 *                 MUST name one. It is checked against the database here,
 *                 and must exist and be active.
 *
 * Because it sets the same `req.orgAdmin` that requireOrgAdmin does, every
 * controller behind it is unchanged - there is no second copy of the roster
 * logic that could drift from the first.
 *
 * It is NOT a drop-in replacement for requireOrgAdmin. Use this only where
 * staff acting on an organisation's behalf makes sense; routes that are
 * genuinely about "your own organisation" keep the stricter gate.
 */
export async function requireOrgScope(req, _res, next) {
  const { rows: who } = await query(
    `select user_type from public.profiles where id = $1`,
    [req.user.id],
  )
  const userType = who[0]?.user_type

  if (userType === 'org_admin') {
    const { rows } = await query(
      `select organization_id from public.org_admins where user_id = $1`,
      [req.user.id],
    )
    if (!rows.length) {
      throw AppError.forbidden('החשבון אינו משויך לארגון.')
    }
    // Deliberately ignores anything the request said.
    req.orgAdmin = { organizationId: rows[0].organization_id, actingAsStaff: false }
    return next()
  }

  if (userType === 'system_admin') {
    const organizationId = req.query.organizationId

    if (!organizationId) {
      throw AppError.badRequest('יש לבחור ארגון.')
    }

    const { rows } = await query(
      `select id from public.organizations where id = $1 and is_active`,
      [organizationId],
    )
    if (!rows.length) {
      throw AppError.notFound('הארגון לא נמצא או שאינו פעיל.')
    }

    req.orgAdmin = { organizationId: rows[0].id, actingAsStaff: true }
    return next()
  }

  throw AppError.forbidden('הפעולה זמינה למנהל.ת מערכת ארגונית או לצוות Equalmind.')
}
