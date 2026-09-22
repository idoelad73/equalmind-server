import { z } from 'zod'
import { query } from '../db/pool.js'

export const behaviorsQuerySchema = z.object({
  space: z.enum(['work', 'community', 'consumption']),
})

/**
 * The whole catalogue for one space, in a single response.
 *
 * A space holds tens of rows, not thousands, so the client gets all of them
 * and does its own filtering. That is what makes the search box in step two
 * instant, and it means picking a category is not a round trip.
 */
export async function getBehaviors(req, res) {
  const { space } = req.validatedQuery

  const { rows } = await query(
    `select id, category_key, category_label, name
       from public.behaviors
      where space = $1 and is_active
      order by category_order, category_key, sort_order, name`,
    [space],
  )

  // Category order follows first appearance, which the ORDER BY above has
  // already settled - so the list and the category cards cannot disagree.
  // category_order comes first in that sort because display order is a
  // product decision; ordering by the slug alone is alphabetical, which is
  // to say arbitrary.
  const categories = []
  const seen = new Map()

  for (const row of rows) {
    let entry = seen.get(row.category_key)
    if (!entry) {
      entry = { key: row.category_key, label: row.category_label, count: 0 }
      seen.set(row.category_key, entry)
      categories.push(entry)
    }
    entry.count += 1
  }

  res.json({
    space,
    categories,
    behaviors: rows.map((r) => ({
      id: r.id,
      categoryKey: r.category_key,
      categoryLabel: r.category_label,
      name: r.name,
    })),
  })
}
