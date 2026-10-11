import { z } from 'zod'
import { query, withTransaction } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'
import { normalizePhone } from '../lib/phone.js'
import { generateJoinCode, hashPhone, normalizeJoinCode } from '../lib/rosterHash.js'
import { applyRoster, planRoster, readRosterFile, tally } from '../lib/rosterImport.js'
import { maskPhone } from '../lib/rosterImport.js'
import {
  activeProvider,
  allowlistActive,
  DEFAULT_INVITE_TEMPLATE,
  isDryProvider,
  MESSAGES,
  segmentsFor,
  sendSms,
} from '../lib/smsProvider.js'
import { env } from '../config/env.js'
import { inviteOrgRepresentative, inviteRedirectUrl } from '../lib/mailProvider.js'

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
    `select org_name, registry_id, registry_source, industry, org_address,
            employee_count, invite_sms_template
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
           (name, registry_id, registry_source, industry, address, employee_count,
            invite_sms_template)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id`,
        [
          declared.org_name,
          declared.registry_id,
          declared.registry_source,
          declared.industry,
          declared.org_address,
          declared.employee_count,
          declared.invite_sms_template,
        ],
      )
      id = created[0].id
    }

    // coalesce, not overwrite: an organisation that already has a template
    // keeps it. A second admin onboarding does not get to silently reword
    // what the first one agreed to.
    if (declared.invite_sms_template) {
      await client.query(
        `update public.organizations
            set invite_sms_template = coalesce(invite_sms_template, $2)
          where id = $1`,
        [id, declared.invite_sms_template],
      )
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


  const rows = await readRosterFile(req.file.buffer, req.file.originalname)
  const { planned, skipped, error } = planRoster(rows, req.orgAdmin.organizationId)

  if (error) throw AppError.badRequest(error)
  if (!planned.length && !skipped.length) {
    throw AppError.badRequest('לא נמצאו שורות בקובץ.')
  }

  // now() is the TRANSACTION timestamp, so every row this import inserts
  // carries exactly this added_at. The invitation dialog hands it straight
  // back as `since`, which is how "only the new ones" can mean the ones
  // THIS upload added rather than the ones we happen not to have messaged.
  const { results, attached, importedAt } = await withTransaction(async (client) => {
    const run = (sql, params) => client.query(sql, params)
    const { rows: [clock] } = await run('select now() as at')
    return { ...(await applyRoster(planned, run)), importedAt: clock.at }
  })

  // Importing never sends. Inviting is a separate, reviewed step through
  // POST /roster/notify - the client opens the invitation dialog after a
  // successful import, and a person approves the wording and the count.
  // A CSV upload that quietly messaged a few hundred people would be the
  // easiest possible mistake to make and the hardest to take back.
  res.status(201).json({
    // `masked` and `fullName` only - the plan's plaintext numbers never
    // leave the server.
    results: results.map(({ line, fullName, department, jobTitle, masked, status, detail }) => ({
      line, fullName, department, jobTitle, masked, status, detail,
    })),
    skipped,
    attached,
    importedAt,
    summary: tally(results),
  })
}

/** The current roster, for the admin's own organisation. Names, never hashes. */
export async function getRoster(req, res) {
  const { rows } = await query(
    `select employee_name, department, job_title, added_at, (claimed_at is not null) as claimed
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

/* ------------------------------------------------- roster notifications */

export const notifySchema = z.object({
  // Default true: the destructive reading of an ambiguous request is the
  // wrong one when the action is "message a list of real people".
  dryRun: z.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Message people already invited once. Off by default; a repeated
  // invitation is the complaint nobody forgives.
  resend: z.boolean().default(false),
  // The timestamp of the import this dialog was opened from, when there was
  // one. It narrows "new" to the rows that import actually added. Without
  // it, "new" falls back to "never invited" - which is the only thing the
  // word can mean on a dialog opened from the dashboard with no upload
  // behind it.
  since: z.iso.datetime().optional(),
})

/**
 * Invite roster members who have not registered yet.
 *
 * Only people who are on the roster, have not claimed their row, and - unless
 * `resend` - have not already been invited. Every message is recorded in
 * sms_outbox before it is attempted, so a crash mid-run cannot produce a
 * message nobody knows about.
 *
 * `dryRun` returns exactly what would be sent, including the real segment
 * count, without touching the gateway. That is the default.
 */
/**
 * Build the invitation for an organisation and count what it will cost.
 *
 * The template is the organisation's own if it has set one. Segment count is
 * computed here, not guessed at the call site, because in Hebrew it is the
 * bill: 70 characters per segment, multiplied by the whole roster.
 */
async function invitationFor(organizationId) {
  const { rows } = await query(
    'select name, invite_sms_template from public.organizations where id = $1',
    [organizationId],
  )
  if (!rows.length) throw AppError.notFound('הארגון לא נמצא.')

  const body = MESSAGES.rosterInvite({
    organizationName: rows[0].name,
    url: env.SMS_INVITE_URL,
    template: rows[0].invite_sms_template,
  })

  return { organizationName: rows[0].name, body, cost: segmentsFor(body) }
}

/**
 * Send the invitation to roster members who have not registered.
 *
 * Shared by POST /roster/notify and the `notify` option on upload, so both
 * obey the same rules: never someone already claimed, never someone already
 * invited unless `resend`, never someone whose number was not stored.
 *
 * Each message is written to sms_outbox BEFORE it is attempted, so a process
 * that dies mid-run still leaves evidence of what it tried.
 */
/**
 * Which roster rows an audience covers, as a SQL fragment.
 *
 * Everyone considered here is already narrowed to "on this roster, has not
 * registered, has a stored number". This decides only the extra filter:
 *
 *   all    no filter. Everyone who has not registered yet.
 *   new    the rows THIS import added, when the dialog came from an upload
 *          and handed back its timestamp; otherwise the rows nobody has
 *          ever been invited from.
 *
 * One definition, used by the count beside each option, by the dry run and
 * by the real send. Three copies of this predicate would be three chances
 * for the button to promise a number the send does not keep - and that is
 * exactly the bug this replaces.
 */
function audienceClause({ resend, since }, paramIndex) {
  if (resend) return { sql: '', params: [] }
  if (since) return { sql: `and added_at >= $${paramIndex}`, params: [since] }
  return { sql: 'and invited_at is null', params: [] }
}

async function sendInvitations({ organizationId, userId, limit, resend, since }) {
  const { body, cost } = await invitationFor(organizationId)
  const audience = audienceClause({ resend, since }, 2)

  const { rows: targets } = await query(
    `select id, phone, employee_name
       from public.org_rosters
      where organization_id = $1
        and claimed_at is null
        and phone is not null
        ${audience.sql}
      order by employee_name
      limit $${2 + audience.params.length}`,
    [organizationId, ...audience.params, limit],
  )

  const results = []

  for (const target of targets) {
    const { rows: [row] } = await query(
      `insert into public.sms_outbox
         (provider, kind, phone, body, organization_id, roster_id, requested_by, status)
       values ($1, 'roster_invite', $2, $3, $4, $5, $6, 'queued')
       on conflict (roster_id) where roster_id is not null and kind = 'roster_invite'
       do update
          set provider = excluded.provider, body = excluded.body,
              status = 'queued', error = null, created_at = now()
       returning id`,
      [activeProvider(), target.phone, body, organizationId, target.id, userId],
    )

    try {
      const { provider, ref, skipped, reason } = await sendSms({ to: target.phone, body })

      if (skipped) {
        // The allowlist declined it. Not a failure, and deliberately NOT
        // stamped as invited - so a later real send still has them to reach.
        await query(
          `update public.sms_outbox set status = 'skipped', error = $2 where id = $1`,
          [row.id, reason],
        )
        results.push({
          name: target.employee_name,
          masked: maskPhone(target.phone),
          status: 'skipped',
          detail: 'מחוץ לרשימת הבדיקה',
        })
        continue
      }

      await query(
        `update public.sms_outbox
            set status = 'sent', provider = $2, provider_ref = $3, sent_at = now()
          where id = $1`,
        [row.id, provider, ref],
      )
      await query('update public.org_rosters set invited_at = now() where id = $1', [target.id])
      results.push({ name: target.employee_name, masked: maskPhone(target.phone), status: 'sent' })
    } catch (error) {
      await query(
        `update public.sms_outbox set status = 'failed', error = $2 where id = $1`,
        [row.id, error?.message ?? 'unknown'],
      )
      results.push({
        name: target.employee_name,
        masked: maskPhone(target.phone),
        status: 'failed',
        detail: error?.message ?? 'שליחה נכשלה',
      })
    }
  }

  return { body, cost, results, summary: tally(results) }
}

export async function postRosterNotify(req, res) {
  const { dryRun, limit, resend, since } = req.body
  const { body, cost } = await invitationFor(req.orgAdmin.organizationId)

  // Rows with no stored number cannot be reached: a hash is not reversible.
  const { rows: [{ unreachable }] } = await query(
    `select count(*)::int as unreachable
       from public.org_rosters
      where organization_id = $1 and claimed_at is null and phone is null`,
    [req.orgAdmin.organizationId],
  )

  if (dryRun) {
    const audience = audienceClause({ resend, since }, 2)
    const { rows: targets } = await query(
      `select phone, employee_name from public.org_rosters
        where organization_id = $1 and claimed_at is null and phone is not null
          ${audience.sql}
        order by employee_name limit $${2 + audience.params.length}`,
      [req.orgAdmin.organizationId, ...audience.params, limit],
    )

    // Both figures, not just the chosen one, so the dialog can label each
    // option with what it would cost. Choosing between "everyone" and "only
    // the new ones" without those numbers is guesswork, and the difference
    // is messages that reach people twice.
    //
    // The "new" figure is built from the SAME clause the send would use, so
    // the number beside the option is the number of messages it sends.
    const narrowed = audienceClause({ resend: false, since }, 2)
    const { rows: [counts] } = await query(
      `select count(*) filter (where true ${narrowed.sql})::int as new_only,
              count(*)::int as all_unclaimed
         from public.org_rosters
        where organization_id = $1 and claimed_at is null and phone is not null`,
      [req.orgAdmin.organizationId, ...narrowed.params],
    )

    return res.json({
      provider: activeProvider(),
      allowlist: allowlistActive(),
      dryRun: true,
      body,
      segments: cost.segments,
      unicode: cost.unicode,
      recipients: targets.length,
      counts: { newOnly: counts.new_only, all: counts.all_unclaimed },
      // How many one send covers. The counts above are uncapped, so without
      // this the dialog cannot tell "2 people" from "2 people, 50 at a time".
      limit,
      unreachable,
      totalSegments: cost.segments * targets.length,
      results: targets.map((t) => ({
        name: t.employee_name,
        masked: maskPhone(t.phone),
        status: 'planned',
      })),
    })
  }

  const sent = await sendInvitations({
    organizationId: req.orgAdmin.organizationId,
    userId: req.user.id,
    limit,
    resend,
    since,
  })

  res.json({
    provider: activeProvider(),
    allowlist: allowlistActive(),
    dryRun: false,
    body: sent.body,
    segments: sent.cost.segments,
    unicode: sent.cost.unicode,
    recipients: sent.results.length,
    unreachable,
    totalSegments: sent.cost.segments * sent.results.length,
    results: sent.results,
    summary: sent.summary,
  })
}

/** What has been sent for this organisation. Most recent first. */
export async function getSmsOutbox(req, res) {
  const { rows } = await query(
    `select o.id, o.provider, o.kind, o.status, o.created_at, o.sent_at, o.error,
            r.employee_name
       from public.sms_outbox o
       left join public.org_rosters r on r.id = o.roster_id
      where o.organization_id = $1
      order by o.created_at desc
      limit 100`,
    [req.orgAdmin.organizationId],
  )

  // The number is deliberately not returned: an admin who can see the
  // roster already knows who is on it, and a list of numbers in an API
  // response is one screenshot away from somewhere it should not be.
  res.json({ provider: activeProvider(), dry: isDryProvider(), messages: rows })
}

/* ------------------------------------------------------ message template */

export const templateSchema = z.object({
  // null clears it, which falls back to the built-in default.
  template: z.string().trim().max(280, 'ההודעה ארוכה מדי').nullable(),
})

/** The organisation's invitation text, and what the default would be. */
export async function getTemplate(req, res) {
  const { rows } = await query(
    'select name, invite_sms_template from public.organizations where id = $1',
    [req.orgAdmin.organizationId],
  )
  if (!rows.length) throw AppError.notFound('הארגון לא נמצא.')

  const template = rows[0].invite_sms_template
  const preview = MESSAGES.rosterInvite({
    organizationName: rows[0].name,
    url: env.SMS_INVITE_URL,
    template,
  })

  res.json({
    organization: rows[0].name,
    template,
    defaultTemplate: DEFAULT_INVITE_TEMPLATE,
    maxLength: 280,
    // The preview is what would actually be sent, with placeholders filled,
    // so the segment count is the real one rather than an estimate from the
    // unrendered template.
    preview,
    ...segmentsFor(preview),
  })
}

export async function putTemplate(req, res) {
  const template = req.body.template || null

  const { rows } = await query(
    `update public.organizations set invite_sms_template = $2
      where id = $1
      returning name, invite_sms_template`,
    [req.orgAdmin.organizationId, template],
  )
  if (!rows.length) throw AppError.notFound('הארגון לא נמצא.')

  const preview = MESSAGES.rosterInvite({
    organizationName: rows[0].name,
    url: env.SMS_INVITE_URL,
    template: rows[0].invite_sms_template,
  })

  res.json({ saved: true, template: rows[0].invite_sms_template, preview, ...segmentsFor(preview) })
}

/* ------------------------------------------- inviting an org representative */

export const inviteRepresentativeSchema = z.object({
  email: z.email('כתובת אימייל לא תקינה').trim().toLowerCase(),

  // Only for the greeting in the invitation email. Optional: the template
  // falls back to a plain "שלום" without it.
  name: z
    .string()
    .trim()
    .max(80, 'השם ארוך מדי')
    .optional()
    .transform((v) => v || undefined),

  // A registry selection, not free text. registryId is what makes the
  // organisation identifiable - a typed name is the one thing that has
  // reliably failed to match a registry name (see migration 012).
  organization: z.object(
    {
      name: z.string({ error: 'יש לבחור ארגון' }).trim().min(2, 'יש לבחור ארגון').max(150),
      // The message is on the type as well as the pattern, so omitting the
      // field reads the same as typing something that is not a registry
      // number - from the form's point of view they are the same mistake.
      registryId: z
        .string({ error: 'יש לבחור ארגון מתוך המרשם' })
        .trim()
        .regex(/^\d{5,15}$/, 'יש לבחור ארגון מתוך המרשם'),
      source: z.enum(['companies', 'nonprofits']).nullable().optional(),
    },
    { error: 'יש לבחור ארגון' },
  ),
})

/**
 * Invite someone to represent their organisation, from the admin UI.
 *
 * The same thing scripts/send-org-invites.mjs does, deliberately in the same
 * order: send first, then grant the role using the id the mail provider
 * returned. Never an id from the request - that is what stops an invitation
 * being redirected onto an account somebody else names.
 *
 * It creates no organisation. The representative declares that on the
 * onboarding form the invitation opens, and activation creates it from what
 * they declared.
 */
export async function postInviteRepresentative(req, res) {
  const { email, name, organization } = req.body

  // An account that already holds the role has nothing to gain from an
  // invitation, and re-inviting would mail a fresh password link for an
  // account already in use.
  const { rows: existing } = await query(
    `select p.user_type
       from auth.users u join public.profiles p on p.id = u.id
      where lower(u.email) = $1`,
    [email],
  )
  if (existing.length) {
    throw AppError.conflict(
      existing[0].user_type === 'org_admin'
        ? 'הכתובת הזו כבר רשומה כנציג ארגון.'
        : 'לכתובת הזו כבר קיים חשבון במערכת.',
    )
  }

  // The organisation exists before the invitation goes out, so the form the
  // representative opens already knows which organisation they are joining.
  // Resolved on registry_id, which migration 012 made unique and normalised -
  // inviting a second representative for the same company reuses the row
  // rather than creating a near-duplicate under a slightly different name.
  const { rows: found } = await query(
    `select id, name from public.organizations
      where registry_id = public.normalize_registry_id($1)`,
    [organization.registryId],
  )

  let org = found[0]
  if (!org) {
    const { rows: created } = await query(
      `insert into public.organizations (name, registry_id, registry_source)
       values ($1, public.normalize_registry_id($2), $3)
       returning id, name`,
      [organization.name, organization.registryId, organization.source ?? null],
    )
    org = created[0]
  }

  // org.name, not organization.name: if the organisation already existed,
  // the email should name it the way the database does.
  const { provider, userId } = await inviteOrgRepresentative({
    email,
    name,
    organizationName: org.name,
  })

  // Both writes with the service role, using the id the invitation produced.
  // org_admins is what loadInviteContext reads to prefill the onboarding
  // form, so without it the representative would be asked to name the
  // organisation that was just chosen for them.
  await withTransaction(async (client) => {
    await client.query(
      `update public.profiles set user_type = 'org_admin' where id = $1`,
      [userId],
    )
    await client.query(
      `insert into public.org_admins (user_id, organization_id, contact_email)
       values ($1, $2, $3)
       on conflict (user_id) do update
          set organization_id = excluded.organization_id, updated_at = now()`,
      [userId, org.id, email],
    )
  })

  res.status(201).json({
    sent: true,
    provider,
    email,
    organization: { id: org.id, name: org.name },
    opensAt: inviteRedirectUrl(),
  })
}

/* ---------------------------------------------- organisations, for staff */

/**
 * Every organisation, for the staff organisation picker.
 *
 * Behind requireSystemAdmin: an org admin has exactly one organisation and
 * has no business enumerating the others. The roster counts come along so
 * the picker can show what it is about to add to.
 */
export async function listOrganizations(_req, res) {
  const { rows } = await query(
    `select o.id, o.name, o.registry_id,
            (select count(*)::int from public.org_rosters r
              where r.organization_id = o.id) as roster_count,
            (select count(*)::int from public.profiles p
              where p.organization_id = o.id) as attached
       from public.organizations o
      where o.is_active
      order by o.name`,
  )
  res.json({ count: rows.length, organizations: rows })
}
