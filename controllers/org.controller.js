import { z } from 'zod'
import { query, withTransaction } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'
import { normalizePhone } from '../lib/phone.js'
import { generateJoinCode, hashPhone, normalizeJoinCode } from '../lib/rosterHash.js'
import { applyRoster, planRoster, tally } from '../lib/rosterImport.js'

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
/**
 * Finish org admin onboarding: create the organisation the admin declared,
 * and attach them to it.
 *
 * Invitations carry no organisation - the invitee declares it on the form -
 * so this is the only place an `organizations` row comes from in that flow.
 * Without it an invited admin has the role and nothing to administer: no
 * organisation, no org_admins row, so requireOrgAdmin refuses them and no
 * roster has anywhere to go.
 *
 * Only ever called by someone already holding the role, which the invite
 * script granted with the service role. It does not promote anybody.
 */
export async function postActivate(req, res) {
  const { rows: profiles } = await query(
    `select user_type from public.profiles where id = $1`,
    [req.user.id],
  )
  if (profiles[0]?.user_type !== 'org_admin') {
    throw AppError.forbidden('הפעולה זמינה למנהל.ת מערכת ארגונית בלבד.')
  }

  const { rows: details } = await query(
    `select org_name, registry_id, registry_source, industry, org_address, employee_count
       from public.org_admin_details where user_id = $1`,
    [req.user.id],
  )
  const declared = details[0]
  if (!declared) throw AppError.badRequest('יש להשלים את פרטי הארגון תחילה.')

  const organizationId = await withTransaction(async (client) => {
    // Reuse rather than duplicate. registry_id is the identity; the name is
    // only a fallback for an organisation with no registration number.
    const { rows: found } = await client.query(
      `select id from public.organizations
        where (registry_id is not null
               and registry_id = public.normalize_registry_id($1))
           or lower(name) = lower($2)
        order by (registry_id is not null
                  and registry_id = public.normalize_registry_id($1)) desc
        limit 1`,
      [declared.registry_id, declared.org_name],
    )

    let id = found[0]?.id
    if (!id) {
      const { rows: created } = await client.query(
        `insert into public.organizations
           (name, registry_id, registry_source, industry, address, employee_count)
         values ($1,$2,$3,$4,$5,$6)
         returning id`,
        [
          declared.org_name,
          declared.registry_id,
          declared.registry_source,
          declared.industry,
          declared.org_address,
          declared.employee_count,
        ],
      )
      id = created[0].id
    }

    await client.query(
      `insert into public.org_admins (user_id, organization_id, contact_email, activated_at)
       values ($1, $2, (select email from public.profiles where id = $1), now())
       on conflict (user_id) do update
          set organization_id = excluded.organization_id,
              activated_at = coalesce(public.org_admins.activated_at, now()),
              updated_at = now()`,
      [req.user.id, id],
    )

    await client.query(
      `update public.org_admin_details set organization_id = $2 where user_id = $1`,
      [req.user.id, id],
    )

    return id
  })

  res.json({ activated: true, organizationId })
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

/* --------------------------------------------------- roster and join code */

export const claimByPhoneSchema = z.object({
  phone: z.string().trim().min(6).max(25),
})

/**
 * Attach the caller to an organisation by matching their phone number
 * against an uploaded roster.
 *
 * The number is normalised to E.164 and hashed before anything is looked up,
 * so the query runs against the same opaque value the import wrote. The
 * plaintext is stored on the caller's OWN profile - they typed it, and SMS
 * will need it - but never anywhere that describes someone else.
 *
 * A roster link outranks a self-declared workplace: the trigger in migration
 * 013 will not let a later declaration overwrite it.
 */
export async function postClaimByPhone(req, res) {
  const e164 = normalizePhone(req.body.phone)
  if (!e164) throw AppError.badRequest('מספר הנייד אינו תקין (למשל 050-1234567).')

  // One account per number, so a second account cannot claim the same row.
  const { rows: taken } = await query(
    'select id from public.profiles where phone = $1 and id <> $2',
    [e164, req.user.id],
  )
  if (taken.length) {
    throw AppError.conflict('מספר הנייד הזה כבר משויך לחשבון אחר.')
  }

  const hash = hashPhone(e164)
  const { rows: roster } = await query(
    `select r.id, r.organization_id, o.name
       from public.org_rosters r
       join public.organizations o on o.id = r.organization_id and o.is_active
      where r.phone_hash = $1`,
    [hash],
  )

  const match = roster[0] ?? null

  await withTransaction(async (client) => {
    if (match) {
      await client.query(
        `update public.profiles
            set phone = $2, organization_id = $3, org_source = 'roster'
          where id = $1`,
        [req.user.id, e164, match.organization_id],
      )
      await client.query(
        `update public.org_rosters
            set claimed_at = coalesce(claimed_at, now()), claimed_by = $2
          where id = $1`,
        [match.id, req.user.id],
      )
    } else {
      // The number is still worth keeping - it is how we reach them later -
      // even though no roster mentions it.
      await client.query('update public.profiles set phone = $2 where id = $1', [
        req.user.id,
        e164,
      ])
    }
  })

  res.json({
    saved: true,
    matched: Boolean(match),
    organization: match ? { id: match.organization_id, name: match.name } : null,
  })
}

export const joinByCodeSchema = z.object({
  code: z.string().trim().min(4).max(20),
})

/**
 * Attach the caller to an organisation with its join code.
 *
 * For everyone the roster misses - someone who signed up before their
 * employer uploaded a list, or whose number the employer does not hold.
 */
export async function postJoinByCode(req, res) {
  const code = normalizeJoinCode(req.body.code)
  if (!code) throw AppError.badRequest('קוד ההצטרפות אינו תקין.')

  const { rows } = await query(
    'select id, name from public.organizations where join_code = $1 and is_active',
    [code],
  )
  const org = rows[0]
  if (!org) throw AppError.notFound('קוד ההצטרפות אינו קיים או שאינו בתוקף.')

  await query(
    `update public.profiles
        set organization_id = $2, org_source = 'code'
      where id = $1`,
    [req.user.id, org.id],
  )

  res.json({ saved: true, organization: { id: org.id, name: org.name } })
}

/** Detach from an organisation, however the link was made. */
export async function deleteAffiliation(req, res) {
  await query(
    `update public.profiles
        set organization_id = null, org_source = null,
            org_name = null, org_registry_id = null, org_registry_source = null
      where id = $1`,
    [req.user.id],
  )
  res.json({ saved: true, organization: null })
}

/* ------------------------------------------------- the org admin's code */

export async function getJoinCode(req, res) {
  const { rows } = await query(
    `select name, join_code, join_code_set_at,
            (select count(*)::int from public.org_rosters r
              where r.organization_id = o.id) as roster_size,
            (select count(*)::int from public.org_rosters r
              where r.organization_id = o.id and r.claimed_at is not null) as roster_claimed,
            (select count(*)::int from public.profiles p
              where p.organization_id = o.id) as attached
       from public.organizations o
      where o.id = $1`,
    [req.orgAdmin.organizationId],
  )

  const org = rows[0]
  if (!org) throw AppError.notFound('הארגון לא נמצא.')

  res.json({
    organization: org.name,
    joinCode: org.join_code,
    setAt: org.join_code_set_at,
    roster: { listed: org.roster_size, claimed: org.roster_claimed },
    attached: org.attached,
  })
}

/**
 * Issue a new join code.
 *
 * Rotating orphans nothing: people already attached stay attached, because
 * the code is checked once, at the moment someone joins, and never again.
 */
export async function postRotateJoinCode(req, res) {
  // The unique index makes a collision a failed insert rather than a silent
  // overlap; retry rather than surface it.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateJoinCode()
    try {
      const { rows } = await query(
        `update public.organizations
            set join_code = $2, join_code_set_at = now()
          where id = $1
          returning join_code, join_code_set_at`,
        [req.orgAdmin.organizationId, code],
      )
      return res.json({ joinCode: rows[0].join_code, setAt: rows[0].join_code_set_at })
    } catch (error) {
      if (error.code !== '23505') throw error
    }
  }
  throw new AppError(500, 'code_generation_failed', 'יצירת קוד ההצטרפות נכשלה. נסה/י שוב.')
}

/* ------------------------------------------------------- roster upload */

/**
 * Load an employee roster for the caller's own organisation.
 *
 * THE ORGANISATION IS NEVER TAKEN FROM THE REQUEST. It comes from
 * req.orgAdmin, which requireOrgAdmin read from the database. An admin
 * uploading into an organisation they name themselves could seed another
 * company's roster, which would attach that company's staff to a list they
 * do not control.
 *
 * That is also why the file has no organisation column any more: there is
 * nothing to mistype, and nothing to mismatch.
 */
export async function postRoster(req, res) {
  if (!req.file) throw AppError.badRequest('לא צורף קובץ.')

  const text = req.file.buffer.toString('utf8')
  const { planned, skipped, error } = planRoster(text, req.orgAdmin.organizationId)

  if (error) throw AppError.badRequest(error)
  if (!planned.length && !skipped.length) {
    throw AppError.badRequest('לא נמצאו שורות בקובץ.')
  }

  const { results, attached } = await withTransaction((client) =>
    applyRoster(planned, (sql, params) => client.query(sql, params)),
  )

  res.status(201).json({
    // `masked` and `fullName` only - the plan's plaintext numbers never
    // leave the server.
    results: results.map(({ line, fullName, masked, status, detail }) => ({
      line, fullName, masked, status, detail,
    })),
    skipped,
    attached,
    summary: tally(results),
  })
}

/** The current roster, for the admin's own organisation. Names, never hashes. */
export async function getRoster(req, res) {
  const { rows } = await query(
    `select employee_name, added_at, (claimed_at is not null) as claimed
       from public.org_rosters
      where organization_id = $1
      order by claimed_at nulls last, employee_name`,
    [req.orgAdmin.organizationId],
  )

  // The organisation is shown in the upload dialog as a confirmation, not as
  // a choice: it is read from the caller's membership, so there is nothing
  // to pick and nothing to mismatch.
  const { rows: org } = await query(
    'select name, registry_id from public.organizations where id = $1',
    [req.orgAdmin.organizationId],
  )

  res.json({
    organization: { name: org[0]?.name ?? null, registryId: org[0]?.registry_id ?? null },
    count: rows.length,
    claimed: rows.filter((r) => r.claimed).length,
    employees: rows,
  })
}

/** Clear the roster. The people already attached by it stay attached. */
export async function deleteRoster(req, res) {
  const { rowCount } = await query(
    'delete from public.org_rosters where organization_id = $1',
    [req.orgAdmin.organizationId],
  )
  res.json({ removed: rowCount })
}
