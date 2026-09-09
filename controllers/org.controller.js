import { z } from 'zod'
import { query } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'

/**
 * Interest submitted through the public form. This creates no account and
 * grants nothing - it is a lead that someone reads before any verification
 * conversation begins.
 */
export const orgRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  mobile: z.string().trim().min(9).max(20),
  contactEmail: z.email().trim().max(254),

  orgName: z.string().trim().min(2).max(150),
  orgAddress: z.string().trim().max(250).optional(),
  industry: z.string().trim().min(2).max(120),
  companyNumber: z.string().trim().max(30).optional(),
  registrySource: z.enum(['companies', 'nonprofits']).optional(),
  employeeCount: z.coerce.number().int().min(0).max(1_000_000).optional(),
  extraNotes: z.string().trim().max(1000).optional(),
})

export async function postOrgRequest(req, res) {
  const b = req.body

  // Inserted with the service role: the table has no RLS policies, so the
  // queue cannot be read or written with the public anon key.
  const { rows } = await query(
    `insert into public.org_registration_requests
       (full_name, mobile, contact_email, org_name, org_address,
        industry, company_number, employee_count, extra_notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id, created_at`,
    [
      b.fullName, b.mobile, b.contactEmail, b.orgName, b.orgAddress ?? null,
      b.industry, b.companyNumber ?? null, b.employeeCount ?? null, b.extraNotes ?? null,
    ],
  )

  // Nothing about the organisation is echoed back - the response says only
  // that it was received.
  res.status(201).json({ received: true, id: rows[0].id })
}

/** Marks an invited admin's account as activated, once they have a session. */
export async function postActivate(req, res) {
  const { rowCount } = await query(
    `update public.org_admins
        set activated_at = coalesce(activated_at, now())
      where user_id = $1`,
    [req.user.id],
  )
  res.json({ activated: rowCount > 0 })
}

/**
 * A regular user's self-declared workplace, set from their profile page.
 *
 * It goes through the server because `profiles` has no UPDATE policy for end
 * users - deliberately, since RLS cannot restrict which columns a policy
 * exposes and any such policy would also put user_type within reach. Here the
 * update names its three columns explicitly.
 */
export const affiliationSchema = z.object({
  name: z.string().trim().min(2).max(150).nullable(),
  registryId: z.string().trim().max(30).nullable().optional(),
  source: z.enum(['companies', 'nonprofits']).nullable().optional(),
})

export async function putAffiliation(req, res) {
  const { name, registryId, source } = req.body

  const { rowCount } = await query(
    `update public.profiles
        set org_name = $2,
            org_registry_id = $3,
            org_registry_source = $4
      where id = $1`,
    [req.user.id, name, name ? (registryId ?? null) : null, name ? (source ?? null) : null],
  )

  if (!rowCount) throw AppError.notFound('הפרופיל לא נמצא.')
  res.json({ saved: true, organization: name ? { name, registryId, source } : null })
}
