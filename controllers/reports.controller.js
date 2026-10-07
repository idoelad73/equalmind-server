import { z } from 'zod'
import { query, withTransaction } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'
import { getSignedUrl } from '../lib/mediaProvider.js'

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v))

/** Where and when - shared by catalogue and custom Hooks. */
const momentFields = {
  localityName: z.string().trim().min(1, 'יש לבחור יישוב').max(120),
  localityCode: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/)
    .optional(),

  occurredAt: z.iso.datetime({ offset: true }).optional(),
  occurredText: optionalText(120),

  notes: optionalText(1000),
}

export const createReportSchema = z.object({
  behaviorId: z.uuid('התנהגות לא תקינה'),
  ...momentFields,
  photoPublicId: optionalText(200),
})

export const TARGET_TYPES = ['employee', 'my_org', 'local_authority', 'business']

/** A behaviors.category_key: the slugs the catalogue already uses. */
export const categoryKeySchema = z.string().trim().regex(/^[a-z0-9_]{1,60}$/, 'קטגוריה לא תקינה')

export const createCustomReportSchema = z
  .object({
    space: z.enum(['work', 'community', 'consumption']),
    description: z.string().trim().min(3, 'יש לתאר את ה-Hook').max(200),

    // Exactly one: an existing category, or the name of a proposed one. A
    // behaviors row cannot exist without a category, so the form asks now
    // rather than leaving the reviewer to guess (migration 025).
    categoryKey: categoryKeySchema.optional(),
    categoryLabel: optionalText(80),

    targetType: z.enum(TARGET_TYPES, 'יש לבחור על מי ה-Hook'),
    targetName: optionalText(120),
    ...momentFields,
  })
  .refine((v) => Boolean(v.categoryKey) !== Boolean(v.categoryLabel), {
    message: 'יש לבחור קטגוריה',
    path: ['categoryKey'],
  })
  .refine((v) => v.targetType !== 'employee' || v.targetName, {
    message: 'יש להזין את שם העובד/ת',
    path: ['targetName'],
  })
  // A name means something only for the two targets that ask for one.
  .transform((v) =>
    v.targetType === 'employee' || v.targetType === 'business'
      ? v
      : { ...v, targetName: undefined },
  )

/**
 * Which organisation a report belongs to.
 *
 * A plain read of the reporter's resolved pointer. It used to join
 * organizations to profiles on a registry number, which was wrong twice over:
 * the column was not unique, so the match could be ambiguous, and the two
 * sides were written in different formats, so it could silently miss.
 * Migration 012 made organizations.registry_id unique and normalised, and
 * profiles.organization_id is now kept in step by trigger.
 *
 * Still resolved server-side from the reporter, never accepted from the
 * request: a client that could name the organisation could file reports into
 * someone else's dashboard.
 */
async function organizationForReporter(userId) {
  const { rows } = await query(
    `select organization_id from public.profiles where id = $1`,
    [userId],
  )
  return rows[0]?.organization_id ?? null
}

/**
 * File a report.
 *
 * The reporter is stored. It is never shown to the organisation - see the
 * header of migration 011 and `listOrganizationReports` below.
 */
export async function createReport(req, res) {
  const body = req.body

  // The space comes from the catalogue row, never from the request. A client
  // could otherwise file a work-space report against a community behaviour
  // and land it in the wrong organisation's dashboard.
  const { rows: behaviors } = await query(
    `select id, space, name from public.behaviors where id = $1 and is_active`,
    [body.behaviorId],
  )

  const behavior = behaviors[0]
  if (!behavior) throw AppError.badRequest('ההתנהגות שנבחרה אינה זמינה.')

  const organizationId = await organizationForReporter(req.user.id)

  const { rows } = await query(
    `insert into public.reports
       (space, behavior_id, behavior_name, locality_code, locality_name,
        occurred_at, occurred_text, notes, photo_public_id,
        user_id, organization_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, created_at`,
    [
      behavior.space,
      behavior.id,
      behavior.name,
      body.localityCode ?? null,
      body.localityName,
      body.occurredAt ?? null,
      body.occurredText ?? null,
      body.notes ?? null,
      body.photoPublicId ?? null,
      req.user.id,
      organizationId,
    ],
  )

  res.status(201).json({ filed: true, id: rows[0].id, createdAt: rows[0].created_at })
}

/**
 * File a Hook about a behaviour that is not in the catalogue.
 *
 * There is no catalogue row to take the space from, so it is the one field
 * here the client declares. That is safe because routing never depended on
 * it: the organisation still comes from the reporter's profile.
 *
 * behavior_id is left null - that is what marks the row as custom - and the
 * reporter's own wording goes into behavior_name. See migration 023.
 */
export async function createCustomReport(req, res) {
  const body = req.body

  // A chosen category must be one this space actually has - otherwise the
  // approval would file the behaviour under a card that does not exist.
  if (body.categoryKey) {
    const { rows: known } = await query(
      `select 1 from public.behaviors where space = $1 and category_key = $2 and is_active limit 1`,
      [body.space, body.categoryKey],
    )
    if (!known.length) throw AppError.badRequest('הקטגוריה שנבחרה אינה קיימת במרחב הזה.')
  }

  const organizationId = await organizationForReporter(req.user.id)

  // The report and its review message are written together. A Hook outside
  // the catalogue that reached the database without reaching the queue would
  // sit there unreviewed with nothing pointing at it, and nobody would know
  // to look - so either both land or neither does.
  const filed = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into public.reports
         (space, behavior_id, behavior_name, category_key, category_label,
          target_type, target_name,
          locality_code, locality_name, occurred_at, occurred_text, notes,
          user_id, organization_id)
       values ($1, null, $2, $12, $13, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, created_at`,
      [
        body.space,
        body.description,
        body.targetType,
        body.targetName ?? null,
        body.localityCode ?? null,
        body.localityName,
        body.occurredAt ?? null,
        body.occurredText ?? null,
        body.notes ?? null,
        req.user.id,
        organizationId,
        body.categoryKey ?? null,
        body.categoryLabel ?? null,
      ],
    )

    const report = rows[0]

    // Named at write time rather than joined at read time: a reviewer should
    // see what the account was called when the Hook was filed, even if it is
    // renamed or deleted afterwards. Falls back to the email, then to a
    // placeholder - a nameless account must still be reviewable.
    const { rows: who } = await client.query(
      `select coalesce(nullif(full_name, ''), nullif(email, ''), 'משתמש/ת ללא שם') as name
         from public.profiles where id = $1`,
      [req.user.id],
    )

    await client.query(
      `insert into public.messages
         (user_id, user_name, new_hook_text, message_type, report_id)
       values ($1, $2, $3, 'new_hook', $4)
       on conflict (report_id) where report_id is not null
       do update set new_hook_text = excluded.new_hook_text, date = now()`,
      [req.user.id, who[0]?.name ?? null, body.description, report.id],
    )

    return report
  })

  res.status(201).json({ filed: true, id: filed.id, createdAt: filed.created_at })
}

/* ------------------------------------------------- the org admin's view */

export const orgReportsQuerySchema = z.object({
  space: z.enum(['work', 'community', 'consumption']).default('work'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
})

/**
 * Reports for the caller's own organisation.
 *
 * THE COLUMN LIST IS THE SECURITY BOUNDARY. `user_id` is absent and must stay
 * absent - never `select *` here, and never add a join back to profiles or
 * auth.users. `target_name` stays out for the same reason in reverse: it can
 * name the employee a Hook is about, and flags are theirs, not their
 * manager's (migration 023). An org admin is frequently the person a report is about, so the
 * reporter's identity reaching this response is the one failure that matters.
 *
 * photo_public_id is selected but deliberately NOT returned: it is exchanged
 * for a freshly signed link below, so the raw id never leaves the server.
 *
 * The organisation comes from `req.orgAdmin`, which requireOrgAdmin read from
 * the database. Nothing about the scope is taken from the request.
 */
export async function listOrganizationReports(req, res) {
  const { space, limit, before } = req.validatedQuery

  const { rows } = await query(
    `select id, space, behavior_id, behavior_name,
            locality_code, locality_name,
            occurred_at, occurred_text, notes, photo_public_id,
            created_at
       from public.reports
      where organization_id = $1
        and space = $2
        and ($3::timestamptz is null or created_at < $3)
      order by created_at desc
      limit $4`,
    [req.orgAdmin.organizationId, space, before ?? null, limit],
  )

  // The photo link is minted here, per request, rather than stored on the
  // row. Without CLOUDINARY_AUTH_TOKEN_KEY a signed Cloudinary URL does not
  // expire, so a stored one would make every database row a permanent,
  // working link to evidence about an identifiable person - and a leaked
  // backup a photo gallery. Minting keeps the link's life tied to a request
  // by an authorised admin, and swapping storage provider stays a one-file
  // change rather than a data migration.
  const reports = rows.map(({ photo_public_id, ...report }) => {
    if (!photo_public_id) return { ...report, photo: null }
    const { url, expiresInSeconds } = getSignedUrl(photo_public_id, { width: 1200 })
    return { ...report, photo: { url, expiresInSeconds } }
  })

  res.json({
    space,
    count: reports.length,
    // Cursor rather than an offset: reports arrive constantly, and an offset
    // would repeat or skip rows as the list shifts underneath.
    nextBefore: reports.length === limit ? reports[reports.length - 1].created_at : null,
    reports,
  })
}
