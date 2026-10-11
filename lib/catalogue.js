/**
 * Adding a behaviour to the catalogue (public.behaviors).
 *
 * Two ways in, one implementation, so they cannot drift:
 *   - a system admin approves a proposed Hook (approveMessage)
 *   - a system admin files a new Hook themselves - they are the approver, so
 *     it skips the queue (createCustomReport)
 *
 * Both take a transaction client: the behaviour, the report's link to it and
 * the message's status are written together or not at all.
 */
import { randomBytes } from 'node:crypto'
import { AppError } from './AppError.js'

/**
 * Turn a category choice into the three columns a behaviors row needs.
 *
 * An existing key takes its label and order from the catalogue. A new label
 * reuses a category of the same name if one exists - two people proposing
 * "תחבורה" should land on one card, not two - and otherwise gets a fresh
 * slug and goes last.
 */
export async function resolveCategory(client, space, { key, label }) {
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

  throw AppError.badRequest('יש לבחור קטגוריה לפני ההוספה לרשימה.')
}

/**
 * Insert the behaviour, last in its category. Same wording already in the
 * catalogue (the unique index is on space + lower(name)): reactivate it
 * rather than fail, and leave its category alone - it was placed there
 * deliberately by someone before.
 */
export async function addToCatalogue(client, { space, name, category }) {
  const { rows: order } = await client.query(
    `select coalesce(max(sort_order), 0) + 10 as next
       from public.behaviors where space = $1 and category_key = $2`,
    [space, category.key],
  )

  const { rows } = await client.query(
    `insert into public.behaviors
       (space, category_key, category_label, category_order, name, sort_order)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (space, lower(name)) do update set is_active = true
     returning id, name, category_key, category_label, (xmax = 0) as created`,
    [space, category.key, category.label, category.order, name, order[0].next],
  )
  return rows[0]
}

/** The behaviour as API responses describe it. */
export const describeBehavior = (behavior) => ({
  id: behavior.id,
  name: behavior.name,
  categoryKey: behavior.category_key,
  categoryLabel: behavior.category_label,
  created: behavior.created,
})
