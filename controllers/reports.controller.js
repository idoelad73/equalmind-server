import { z } from 'zod'
import { query } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v))

export const createReportSchema = z.object({
  behaviorId: z.uuid('התנהגות לא תקינה'),

  localityName: z.string().trim().min(1, 'יש לבחור יישוב').max(120),
  localityCode: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/)
    .optional(),

  occurredAt: z.iso.datetime({ offset: true }).optional(),
  occurredText: optionalText(120),

  notes: optionalText(1000),
  photoPublicId: optionalText(200),
})

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
 * auth.users. An org admin is frequently the person a report is about, so the
 * reporter's identity reaching this response is the one failure that matters.
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

  res.json({
    space,
    count: rows.length,
    // Cursor rather than an offset: reports arrive constantly, and an offset
    // would repeat or skip rows as the list shifts underneath.
    nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null,
    reports: rows,
  })
}
