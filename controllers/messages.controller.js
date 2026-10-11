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
    targetType: z.enum(TARGET_TYPES).optional(),
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
export async function getUnreadCount(req, res) {
  const { rows } = await query(
    `select count(*)::int as pending from public.messages where status = 'pending'`,
  )
  res.json({ pending: rows[0].pending })
}

export async function listMessages(req, res) {
  const { status, limit } = req.validatedQuery

  const { rows } = await query(
    `select m.message_id, m.user_name, m.new_hook_text, m.date, m.message_type,
            m.status, m.handled_at, m.handling_note, m.behavior_id, m.edits,
            r.space, r.target_type, r.target_name,
            -- locality_code comes along so the reviewer's picker can show
            -- the stored locality as a selection rather than as bare text.
            r.locality_name, r.locality_code, r.occurred_at, r.occurred_text, r.notes,
            r.category_key,
            -- What the reviewer reads: the existing category's current
            -- label, or the new one the reporter proposed.
            coalesce(
              (select b.category_label from public.behaviors b
                where b.space = r.space and b.category_key = r.category_key
                limit 1),
              r.category_label
            ) as category_label,
            (r.category_key is null and r.category_label is not null) as category_is_new
       from public.messages m
       left join public.reports r on r.id = m.report_id
      where ($1 = 'all' or m.status = $1)
      order by m.date desc
      limit $2`,
    [status, limit],
  )

  // user_id is left out on purpose. The name is enough to review free text,
  // and an id in a response is the thing that gets joined to something else
  // later.
  res.json({ status, count: rows.length, messages: rows })
}

/** Deny one proposal. The Hook itself still counts - see migration 024. */
async function decide(req, res, status) {
  const { rows } = await query(
    `update public.messages
        set status = $2,
            handled_at = now(),
            handled_by = $3,
            handling_note = $4
      where message_id = $1 and status = 'pending'
      returning message_id, status, handled_at`,
    [req.params.id, status, req.user.id, req.body.note ?? null],
  )

  if (!rows.length) {
    // Either it does not exist or somebody already decided it. Saying
    // "already handled" is more useful than a bare 404, and two reviewers
    // clicking at once is the normal way this happens.
    const { rows: existing } = await query(
      'select status from public.messages where message_id = $1',
      [req.params.id],
    )
    if (!existing.length) throw AppError.notFound('ההודעה לא נמצאה.')
    throw AppError.conflict(`ההודעה כבר טופלה (${existing[0].status}).`)
  }

  res.json(rows[0])
}

export const denyMessage = (req, res) => decide(req, res, 'denied')

/**
 * Approve a proposal: the wording joins public.behaviors, so the next
 * person filing in that space can simply pick it.
 *
 * One transaction for all three writes - the behaviour, the report's link
 * to it, and the message's status. An approved message with no behaviour
 * behind it would read as done while nothing changed in the wizard.
 *
 * The message row is locked first (FOR UPDATE), so two reviewers approving
 * at once cannot both insert: the second waits, then sees it is no longer
 * pending.
 */
export async function approveMessage(req, res) {
  const body = req.body

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `select m.message_id, m.status, m.new_hook_text, m.report_id,
              r.space, r.category_key, r.category_label,
              r.behavior_name, r.target_type, r.target_name, r.target_worker_id,
              r.locality_name, r.locality_code, r.occurred_at, r.occurred_text,
              r.notes
         from public.messages m
         left join public.reports r on r.id = m.report_id
        where m.message_id = $1
        for update of m`,
      [req.params.id],
    )

    const message = rows[0]
    if (!message) throw AppError.notFound('ההודעה לא נמצאה.')
    if (message.status !== 'pending') {
      throw AppError.conflict(`ההודעה כבר טופלה (${message.status}).`)
    }
    // The space comes only from the report. Without it there is no way to
    // know which wizard the behaviour belongs in, and guessing would put it
    // in front of the wrong people.
    if (!message.space) {
      throw AppError.badRequest('ה-Hook המקורי נמחק, ולכן לא ידוע לאיזה מרחב לשייך אותו.')
    }

    const space = body.space ?? message.space
    const name = body.name ?? message.new_hook_text

    // The reviewer's choice wins; otherwise whatever the reporter picked.
    const category = await resolveCategory(client, space, {
      key: body.categoryKey ?? (body.categoryLabel ? null : message.category_key),
      label: body.categoryKey ? null : (body.categoryLabel ?? message.category_label),
    })

    const behavior = await addToCatalogue(client, { space, name, category })

    // The Hook now points at a real catalogue row, so it counts alongside
    // every later report of the same behaviour - and carries whatever the
    // reviewer corrected. `edits` holds what each field used to say.
    const edits = message.report_id ? await applyReviewEdits(client, message, body, name) : null

    if (message.report_id) {
      await client.query(
        `update public.reports set behavior_id = $1 where id = $2 and behavior_id is null`,
        [behavior.id, message.report_id],
      )
    }

    const { rows: handled } = await client.query(
      `update public.messages
          set status = 'approved', handled_at = now(), handled_by = $2,
              handling_note = $3, behavior_id = $4,
              new_hook_text = $5, edits = $6
        where message_id = $1
        returning message_id, status, handled_at, edits`,
      [
        message.message_id,
        req.user.id,
        body.note ?? null,
        behavior.id,
        name,
        edits ? JSON.stringify(edits) : null,
      ],
    )

    return { ...handled[0], behavior: describeBehavior(behavior) }
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
