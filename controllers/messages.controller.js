import { z } from 'zod'
import { query, withTransaction } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'
import { addToCatalogue, describeBehavior, resolveCategory } from '../lib/catalogue.js'
import { categoryKeySchema, TARGET_TYPES } from './reports.controller.js'

/**
 * The system admin's review queue.
 *
 * Only reachable behind requireSystemAdmin. These rows name the reporter,
 * which is the point of a moderation queue and is also why nothing here is
 * ever exposed to an organisation - the org admin reads public.reports,
 * which returns no reporter at all.
 */

export const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const decisionSchema = z.object({
  note: z.string().trim().max(500).optional(),
})

/**
 * Text a reviewer may blank out. `null` means "clear this field"; leaving
 * the key out entirely means "do not touch it". Those are different
 * instructions and the difference matters - a form that cannot express
 * "remove what is there" quietly makes every field append-only.
 */
const clearableText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()

/**
 * Approving may correct what the reporter wrote before it joins the
 * catalogue. Every field is optional: left out, the reporter's own version
 * stands.
 *
 * `name` and the category decide the catalogue row. The rest edit the
 * REPORT - somebody else's account of something that happened to them - so
 * approveMessage records the old value of each one in messages.edits
 * before overwriting it. See migration 029.
 */
export const approveSchema = decisionSchema
  .extend({
    name: z.string().trim().min(3, 'הנוסח קצר מדי').max(200).optional(),
    categoryKey: categoryKeySchema.optional(),
    categoryLabel: z.string().trim().min(2, 'שם הקטגוריה קצר מדי').max(80).optional(),

    // The report's own fields.
    space: z.enum(['work', 'community', 'consumption']).optional(),
    // Nullable like the clearable text beside it: absent means "leave
    // it", null means "this Hook is about nobody in particular".
    // Without null a reviewer could change a target but never remove
    // one, and applyReviewEdits already understands the difference.
    targetType: z.enum(TARGET_TYPES).nullable().optional(),
    targetName: clearableText(120),
    localityName: clearableText(120),
    localityCode: z.string().trim().regex(/^\d{1,6}$/).nullable().optional(),
    occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
    occurredText: clearableText(120),
    notes: clearableText(1000),
  })
  .refine((v) => !(v.categoryKey && v.categoryLabel), {
    message: 'יש לבחור קטגוריה קיימת או חדשה, לא את שתיהן',
    path: ['categoryKey'],
  })
  // Mirrors the reports_employee_has_name constraint, so a reviewer gets a
  // sentence in Hebrew rather than a 500 from Postgres.
  .refine((v) => v.targetType !== 'employee' || v.targetName !== null, {
    message: 'Hook על עובד/ת חייב לכלול שם',
    path: ['targetName'],
  })
  // Same rule the filing form follows: a CBS code with no name is half a
  // locality, countable but not showable.
  .refine((v) => !(v.localityCode && v.localityName === null), {
    message: 'יש לציין את שם היישוב',
    path: ['localityName'],
  })

/**
 * How many are waiting. Its own endpoint because the navbar polls it, and
 * polling the full queue to count it would ship the queue to every client
 * on a timer.
 */
/**
 * THE QUEUE IS NOT A TABLE.
 *
 * It is public.reports, filtered by reports.review_status - a column that
 * defaults to 'pending', so nothing has to remember to enqueue a new Hook.
 * A separate queue table would have to be written at the moment a Hook is
 * filed, and a second write at the same moment can fail, be retried or be
 * skipped - and then the queue and the reports disagree with nobody to
 * notice.
 *
 * public.messages holds the DECISION, not the arrival: who acted, when,
 * with what note, and what they corrected. It is written in the same
 * transaction as the status, so the two cannot drift.
 *
 *   behavior_id is null   the Hook proposes wording not in the catalogue.
 *                         Approving it adds a behaviors row.
 *   behavior_id is set    the behaviour is already in the catalogue.
 *                         Approving it means "I have read this".
 *
 * That distinction is read from the report, not stored anywhere, so it
 * cannot go stale either.
 */
const QUEUE_FROM = `
    from public.reports r
    left join public.messages m on m.report_id = r.id
    left join public.profiles p on p.id = r.user_id
    left join public.organizations o on o.id = r.organization_id`

/**
 * The state lives on the report (migration 035), so it is read, not
 * computed. messages is still joined for the DECISION behind it - who
 * acted, when, and what they corrected - which is an audit trail rather
 * than a status.
 */
const STATUS = 'r.review_status'

/**
 * How many Hooks are waiting. Its own endpoint because the navbar polls
 * it, and polling the whole queue to count it would ship the queue to
 * every client on a timer.
 */
export async function getUnreadCount(req, res) {
  const { rows } = await query(
    `select count(*)::int as pending
       ${QUEUE_FROM}
      where ${STATUS} = 'pending'`,
  )
  res.json({ pending: rows[0].pending })
}

export async function listMessages(req, res) {
  const { status, limit } = req.validatedQuery

  const { rows } = await query(
    `select r.id,
            r.space, r.behavior_id, r.behavior_name as new_hook_text,
            r.category_key,
            r.target_type, r.target_name,
            r.locality_name, r.occurred_at, r.occurred_text, r.notes,
            r.created_at as date,
            -- The reporter's name is read live rather than snapshotted: a
            -- queue derived from reports has no moment at which to take a
            -- copy. A deleted account simply shows no name.
            p.full_name as user_name,
            o.name as organization_name,
            -- What the reviewer reads: the existing category's current
            -- label, or the new one the reporter proposed.
            coalesce(
              (select b.category_label from public.behaviors b
                where b.space = r.space and b.category_key = r.category_key
                limit 1),
              r.category_label
            ) as category_label,
            (r.category_key is null and r.category_label is not null) as category_is_new,
            -- Null behavior_id means the wording is not in the catalogue,
            -- so approving it has to put it there. Set means it already is.
            (r.behavior_id is null) as needs_catalogue,
            ${STATUS} as status,
            m.handled_at, m.handling_note, m.edits
       ${QUEUE_FROM}
      where ($1 = 'all' or ${STATUS} = $1)
      order by r.created_at desc
      limit $2`,
    [status, limit],
  )

  // user_id is left out on purpose. The name is enough to review free text,
  // and an id in a response is the thing that gets joined to something else
  // later.
  res.json({ status, count: rows.length, messages: rows })
}

/**
 * Load the Hook under review and lock it.
 *
 * FOR UPDATE on the REPORT, not on a queue row - there may be no queue row
 * yet. Two reviewers acting at once then serialise here, and the second
 * one sees the decision the first just wrote.
 */
async function lockForReview(client, reportId) {
  const { rows } = await client.query(
    `select r.id as report_id, r.space, r.behavior_id, r.behavior_name,
            r.category_key, r.category_label,
            r.target_type, r.target_name, r.target_worker_id,
            r.locality_name, r.locality_code, r.occurred_at, r.occurred_text,
            r.notes, r.user_id,
            p.full_name as user_name,
            r.review_status as status,
            m.message_id
       from public.reports r
       left join public.messages m on m.report_id = r.id
       left join public.profiles p on p.id = r.user_id
      where r.id = $1
      for update of r`,
    [reportId],
  )

  const row = rows[0]
  if (!row) throw AppError.notFound('ה-Hook לא נמצא.')
  if (row.status !== 'pending') {
    // Saying "already handled" is more useful than a bare 404, and two
    // reviewers clicking at once is the normal way this happens.
    throw AppError.conflict(`ה-Hook כבר טופל (${row.status}).`)
  }
  return row
}

/**
 * Write the decision.
 *
 * ON CONFLICT on messages_report_key - the partial unique index on
 * report_id - so a decision is upserted rather than duplicated, however
 * many times this path runs for one Hook.
 */
async function recordDecision(client, { report, status, userId, note, name, behaviorId, edits }) {
  // The status and its decision, in one transaction. Either both land or
  // neither does - which is the whole reason the status is not kept in a
  // second table that something has to remember to update.
  await client.query(
    'update public.reports set review_status = $2 where id = $1',
    [report.report_id, status],
  )

  const { rows } = await client.query(
    `insert into public.messages
       (user_id, user_name, new_hook_text, message_type, report_id,
        status, handled_at, handled_by, handling_note, behavior_id, edits)
     values ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10)
     on conflict (report_id) where report_id is not null do update
        set status = excluded.status,
            handled_at = excluded.handled_at,
            handled_by = excluded.handled_by,
            handling_note = excluded.handling_note,
            behavior_id = coalesce(excluded.behavior_id, public.messages.behavior_id),
            new_hook_text = excluded.new_hook_text,
            edits = excluded.edits
     returning message_id, status, handled_at, edits`,
    [
      report.user_id,
      report.user_name,
      name,
      // 'new_hook' only when it really proposed one - see migration 034.
      report.behavior_id ? 'report' : 'new_hook',
      report.report_id,
      status,
      userId,
      note ?? null,
      behaviorId ?? null,
      edits ? JSON.stringify(edits) : null,
    ],
  )
  return rows[0]
}

/** Reject one Hook. The report itself stands - see migration 024. */
export async function denyMessage(req, res) {
  const result = await withTransaction(async (client) => {
    const report = await lockForReview(client, req.params.id)
    return recordDecision(client, {
      report,
      status: 'denied',
      userId: req.user.id,
      note: req.body.note,
      name: report.behavior_name,
    })
  })

  res.json(result)
}

/**
 * Approve one Hook.
 *
 * What that means depends on the Hook, and the report decides:
 *
 *   wording not in the catalogue  it joins public.behaviors and the report
 *                                 is linked to the new row.
 *   wording already there         nothing is added. The decision is only
 *                                 the record that a reviewer read it.
 *
 * Either way the reviewer's corrections are applied to the report, with
 * the previous value of each field kept in messages.edits.
 */
export async function approveMessage(req, res) {
  const body = req.body

  const result = await withTransaction(async (client) => {
    const report = await lockForReview(client, req.params.id)

    const space = body.space ?? report.space
    const name = body.name ?? report.behavior_name
    let behavior = null

    if (!report.behavior_id) {
      // The reviewer's choice wins; otherwise whatever the reporter picked.
      const category = await resolveCategory(client, space, {
        key: body.categoryKey ?? (body.categoryLabel ? null : report.category_key),
        label: body.categoryKey ? null : (body.categoryLabel ?? report.category_label),
      })

      behavior = await addToCatalogue(client, { space, name, category })

      // The Hook now points at a real catalogue row, so it counts alongside
      // every later report of the same behaviour.
      await client.query(
        `update public.reports set behavior_id = $1 where id = $2 and behavior_id is null`,
        [behavior.id, report.report_id],
      )
    }

    const edits = await applyReviewEdits(client, report, body, name)

    const decision = await recordDecision(client, {
      report,
      status: 'approved',
      userId: req.user.id,
      note: body.note,
      name,
      behaviorId: behavior?.id,
      edits,
    })

    return { ...decision, behavior: behavior ? describeBehavior(behavior) : null }
  })

  res.json(result)
}

/**
 * The report columns a reviewer may correct, and where each one's new
 * value comes from in the request body.
 *
 * behavior_name is in here and `name` drives it: the wording the reviewer
 * settled on is the wording the report should read, not the typo it was
 * filed with. The original survives in `edits`, which is the whole reason
 * that column exists.
 */
const EDITABLE = [
  ['behavior_name', (body, name) => name],
  ['space', (body) => body.space],
  ['target_type', (body) => body.targetType],
  ['target_name', (body) => body.targetName],
  ['locality_name', (body) => body.localityName],
  ['locality_code', (body) => body.localityCode],
  ['occurred_at', (body) => body.occurredAt],
  ['occurred_text', (body) => body.occurredText],
  ['notes', (body) => body.notes],
]

/** Two values are "the same" if both are empty or both read alike. */
const same = (a, b) => {
  if (a instanceof Date) return b !== null && b !== undefined && +a === +new Date(b)
  return (a ?? null) === (b ?? null)
}

/**
 * Apply the reviewer's corrections to the report, and return a record of
 * what they replaced.
 *
 * Only columns the request actually named are considered, and of those,
 * only the ones whose value really changed - so an approval that touched
 * nothing writes nothing and leaves `edits` null.
 *
 * Changing who a Hook is about drops target_worker_id. That column links
 * to a specific colleague; leaving it attached to a name the reviewer just
 * replaced would point the Hook at the wrong person while reading right.
 */
async function applyReviewEdits(client, report, body, name) {
  const edits = {}
  const sets = []
  const params = []

  for (const [column, read] of EDITABLE) {
    const next = read(body, name)
    if (next === undefined) continue
    if (same(report[column], next)) continue

    edits[column] = {
      from: report[column] instanceof Date ? report[column].toISOString() : (report[column] ?? null),
      to: next,
    }
    params.push(next)
    sets.push(`${column} = $${params.length}`)
  }

  if (!sets.length) return null

  if (edits.target_type || edits.target_name) {
    sets.push('target_worker_id = null')
    if (report.target_worker_id) {
      edits.target_worker_id = { from: report.target_worker_id, to: null }
    }
  }

  params.push(report.report_id)
  await client.query(
    `update public.reports set ${sets.join(', ')} where id = $${params.length}`,
    params,
  )

  return edits
}
