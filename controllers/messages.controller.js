import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { query, withTransaction } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'
import { categoryKeySchema } from './reports.controller.js'

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
 * Approving may correct what the reporter wrote before it joins the
 * catalogue. Every field is optional: left out, the reporter's own wording
 * and category are used.
 */
export const approveSchema = decisionSchema
  .extend({
    name: z.string().trim().min(3, 'הנוסח קצר מדי').max(200).optional(),
    categoryKey: categoryKeySchema.optional(),
    categoryLabel: z.string().trim().min(2, 'שם הקטגוריה קצר מדי').max(80).optional(),
  })
  .refine((v) => !(v.categoryKey && v.categoryLabel), {
    message: 'יש לבחור קטגוריה קיימת או חדשה, לא את שתיהן',
    path: ['categoryKey'],
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
            m.status, m.handled_at, m.handling_note, m.behavior_id,
            r.space, r.target_type, r.target_name,
            r.locality_name, r.occurred_at, r.occurred_text, r.notes,
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
              r.space, r.category_key, r.category_label
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

    const space = message.space
    const name = body.name ?? message.new_hook_text

    // The reviewer's choice wins; otherwise whatever the reporter picked.
    const category = await resolveCategory(client, space, {
      key: body.categoryKey ?? (body.categoryLabel ? null : message.category_key),
      label: body.categoryKey ? null : (body.categoryLabel ?? message.category_label),
    })

    const { rows: order } = await client.query(
      `select coalesce(max(sort_order), 0) + 10 as next
         from public.behaviors where space = $1 and category_key = $2`,
      [space, category.key],
    )

    // Same wording already in the catalogue (the unique index is on
    // space + lower(name)): reactivate it rather than fail. Its category is
    // left alone - it was placed there deliberately by someone before.
    const { rows: inserted } = await client.query(
      `insert into public.behaviors
         (space, category_key, category_label, category_order, name, sort_order)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (space, lower(name)) do update set is_active = true
       returning id, name, category_key, category_label, (xmax = 0) as created`,
      [space, category.key, category.label, category.order, name, order[0].next],
    )
    const behavior = inserted[0]

    // The Hook now points at a real catalogue row, so it counts alongside
    // every later report of the same behaviour. behavior_name keeps the
    // reporter's original wording, as it does for every report.
    if (message.report_id) {
      await client.query(
        `update public.reports set behavior_id = $1 where id = $2 and behavior_id is null`,
        [behavior.id, message.report_id],
      )
    }

    const { rows: handled } = await client.query(
      `update public.messages
          set status = 'approved', handled_at = now(), handled_by = $2,
              handling_note = $3, behavior_id = $4
        where message_id = $1
        returning message_id, status, handled_at`,
      [message.message_id, req.user.id, body.note ?? null, behavior.id],
    )

    return {
      ...handled[0],
      behavior: {
        id: behavior.id,
        name: behavior.name,
        categoryKey: behavior.category_key,
        categoryLabel: behavior.category_label,
        created: behavior.created,
      },
    }
  })

  res.json(result)
}

/**
 * Turn a category choice into the three columns a behaviors row needs.
 *
 * An existing key takes its label and order from the catalogue. A new label
 * reuses a category of the same name if one exists - two people proposing
 * "תחבורה" should land on one card, not two - and otherwise gets a fresh
 * slug and goes last.
 */
async function resolveCategory(client, space, { key, label }) {
  if (key) {
    const { rows } = await client.query(
      `select category_key as key, category_label as label, category_order as "order"
         from public.behaviors where space = $1 and category_key = $2
        limit 1`,
      [space, key],
    )
    if (!rows.length) throw AppError.badRequest('הקטגוריה שנבחרה אינה קיימת במרחב הזה.')
    return rows[0]
  }

  if (label) {
    const { rows: same } = await client.query(
      `select category_key as key, category_label as label, category_order as "order"
         from public.behaviors where space = $1 and lower(category_label) = lower($2)
        limit 1`,
      [space, label],
    )
    if (same.length) return same[0]

    const { rows: last } = await client.query(
      `select coalesce(max(category_order), 0) + 10 as next
         from public.behaviors where space = $1`,
      [space],
    )
    // The label is Hebrew, so it cannot become a readable slug. The key only
    // has to be stable and unique; the client shows a generic icon for it.
    return { key: `c_${randomBytes(4).toString('hex')}`, label, order: last[0].next }
  }

  throw AppError.badRequest('יש לבחור קטגוריה לפני האישור.')
}
