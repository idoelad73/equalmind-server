import { z } from 'zod'
import { query } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'
import { getSignedUrl } from '../lib/mediaProvider.js'
import { TARGET_TYPES } from './reports.controller.js'

/**
 * Every Hook in the system, for Equalmind staff.
 *
 * ALL OF THESE SIT BEHIND requireSystemAdmin. They are the one place a
 * report's reporter and target are both readable, which is exactly why the
 * ORGANISATION's view is a different endpoint with a different column list:
 * see listOrganizationReports, which returns no reporter at all and never
 * target_name. Do not merge the two. The question "who may see this row"
 * has two different answers and they belong in two different queries.
 */

const SPACES = ['work', 'community', 'consumption']

export const listSchema = z.object({
  // Free text over the behaviour's wording and the target's name - the two
  // things someone remembers about a Hook they are looking for.
  q: z.string().trim().max(120).optional(),
  space: z.enum(SPACES).optional(),

  // The review state, the same three the queue shows. Only a Hook filed
  // outside the catalogue has one - a catalogue Hook proposes nothing and
  // so has no message behind it. Filtering by a status therefore excludes
  // those by design; 'none' asks for exactly them.
  status: z.enum(['pending', 'approved', 'denied', 'none']).optional(),
  // 'none' is not a status - it asks for the Hooks that need no catalogue
  // decision, which is a property of the report, not of the queue.

  // The window is on when it HAPPENED, falling back to when it was filed
  // for the rows that never said - see the coalesce below. A filter that
  // silently dropped every undated row would hide exactly the reports
  // somebody is hunting for.
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),

  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

/** The fields staff may correct. Absent means "leave it"; null means "clear it". */
const clearableText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()

export const updateSchema = z
  .object({
    behaviorName: z.string().trim().min(3, 'הנוסח קצר מדי').max(200).optional(),
    space: z.enum(SPACES).optional(),
    targetType: z.enum(TARGET_TYPES).nullable().optional(),
    targetName: clearableText(120),
    localityName: clearableText(120),
    localityCode: z.string().trim().regex(/^\d{1,6}$/).nullable().optional(),
    occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
    occurredText: clearableText(120),
    notes: clearableText(1000),
  })
  // Mirrors the reports_employee_has_name constraint, so a reviewer gets a
  // sentence in Hebrew rather than a 500 from Postgres.
  .refine((v) => v.targetType !== 'employee' || v.targetName !== null, {
    message: 'Hook על עובד/ת חייב לכלול שם',
    path: ['targetName'],
  })
  .refine((v) => !(v.localityCode && v.localityName === null), {
    message: 'יש לציין את שם היישוב',
    path: ['localityName'],
  })

/** Staff adding a Hook by hand: the wording and the space are required. */
export const adminCreateSchema = z
  .object({
    behaviorName: z.string().trim().min(3, 'הנוסח קצר מדי').max(200),
    space: z.enum(SPACES),
    behaviorId: z.uuid().nullable().optional(),
    targetType: z.enum(TARGET_TYPES).nullable().optional(),
    targetName: clearableText(120),
    localityName: clearableText(120),
    localityCode: z.string().trim().regex(/^\d{1,6}$/).nullable().optional(),
    occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
    occurredText: clearableText(120),
    notes: clearableText(1000),
  })
  .refine((v) => v.targetType !== 'employee' || v.targetName, {
    message: 'Hook על עובד/ת חייב לכלול שם',
    path: ['targetName'],
  })

export async function listAllReports(req, res) {
  const { q, space, status, from, to, limit, offset } = req.validatedQuery

  // Built as a list so a filter that is not asked for contributes neither a
  // clause nor a parameter - string-concatenating SQL is how a placeholder
  // ends up one off from its value.
  const where = ['true']
  const params = []
  const add = (sql, value) => {
    params.push(value)
    where.push(sql.replace('$?', `$${params.length}`))
  }

  if (space) add('r.space = $?', space)
  if (status === 'none') where.push('r.behavior_id is not null')
  else if (status) add('r.review_status = $?', status)
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`)
    where.push(`(r.behavior_name ilike $${params.length} or r.target_name ilike $${params.length})`)
  }
  if (from) add('coalesce(r.occurred_at, r.created_at) >= $?::date', from)
  // The end of the chosen day, not its start: a window of one day must
  // include the day it names.
  if (to) add("coalesce(r.occurred_at, r.created_at) < ($?::date + interval '1 day')", to)

  params.push(limit, offset)

  const { rows } = await query(
    `select r.id, r.space, r.behavior_id, r.behavior_name,
            r.category_key, r.category_label,
            r.target_type, r.target_name,
            r.locality_name, r.locality_code,
            r.occurred_at, r.occurred_text, r.notes,
            r.photo_public_id, r.created_at,
            o.name as organization_name,
            p.full_name as reporter_name,
            r.review_status,
            (r.behavior_id is null) as needs_catalogue,
            count(*) over () as total
       from public.reports r
       left join public.organizations o on o.id = r.organization_id
       left join public.profiles p on p.id = r.user_id
      where ${where.join(' and ')}
      order by coalesce(r.occurred_at, r.created_at) desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  )

  res.json({
    total: rows[0] ? Number(rows[0].total) : 0,
    limit,
    offset,
    reports: rows.map(({ total, photo_public_id, ...row }) => ({
      ...row,
      // Minted per request, never stored - the same rule the organisation's
      // view follows. See lib/mediaProvider.js.
      photo: photo_public_id ? getSignedUrl(photo_public_id) : null,
    })),
  })
}

/** The columns an edit may touch, and where each new value comes from. */
const EDITABLE = [
  ['behavior_name', (b) => b.behaviorName],
  ['space', (b) => b.space],
  ['target_type', (b) => b.targetType],
  ['target_name', (b) => b.targetName],
  ['locality_name', (b) => b.localityName],
  ['locality_code', (b) => b.localityCode],
  ['occurred_at', (b) => b.occurredAt],
  ['occurred_text', (b) => b.occurredText],
  ['notes', (b) => b.notes],
]

export async function updateReport(req, res) {
  const sets = []
  const params = []

  for (const [column, read] of EDITABLE) {
    const next = read(req.body)
    if (next === undefined) continue
    params.push(next)
    sets.push(`${column} = $${params.length}`)
  }

  if (!sets.length) throw AppError.badRequest('לא נשלחו שינויים.')

  // Changing who a Hook is about drops target_worker_id: that column links
  // to a specific colleague, and leaving it attached to a name just
  // replaced would point the Hook at the wrong person while reading right.
  if (req.body.targetType !== undefined || req.body.targetName !== undefined) {
    sets.push('target_worker_id = null')
  }

  params.push(req.params.id)
  const { rows } = await query(
    `update public.reports set ${sets.join(', ')}
      where id = $${params.length}
      returning id, space, behavior_name, target_type, target_name,
                locality_name, occurred_at, occurred_text, notes`,
    params,
  )

  if (!rows.length) throw AppError.notFound('ה-Hook לא נמצא.')
  res.json(rows[0])
}

/**
 * Remove a Hook.
 *
 * The review-queue message that points at it is NOT deleted: messages.
 * report_id is ON DELETE SET NULL, so the decision stays readable with the
 * report gone. A moderation record that disappears with the thing it
 * moderated is not a record.
 */
export async function deleteReport(req, res) {
  const { rowCount } = await query('delete from public.reports where id = $1', [req.params.id])
  if (!rowCount) throw AppError.notFound('ה-Hook לא נמצא.')
  res.json({ deleted: true, id: req.params.id })
}

/**
 * Staff filing a Hook by hand.
 *
 * user_id is left null on purpose: nobody reported this, staff entered it,
 * and writing the admin's own id there would make them the reporter of
 * somebody else's account. organization_id is left null too - a Hook with
 * no reporter has no employer to route to.
 */
export async function createReportAsAdmin(req, res) {
  const b = req.body

  const { rows } = await query(
    `insert into public.reports
       (space, behavior_id, behavior_name, category_key, category_label,
        target_type, target_name, locality_code, locality_name,
        occurred_at, occurred_text, notes, user_id, organization_id)
     values ($1, $2, $3, null, null, $4, $5, $6, $7, $8, $9, $10, null, null)
     returning id, created_at`,
    [
      b.space,
      b.behaviorId ?? null,
      b.behaviorName,
      b.targetType ?? null,
      b.targetName ?? null,
      b.localityCode ?? null,
      b.localityName ?? null,
      b.occurredAt ?? null,
      b.occurredText ?? null,
      b.notes ?? null,
    ],
  )

  res.status(201).json({ id: rows[0].id, createdAt: rows[0].created_at })
}
