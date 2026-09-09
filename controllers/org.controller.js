import { z } from 'zod'
import { query } from '../db/pool.js'

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
