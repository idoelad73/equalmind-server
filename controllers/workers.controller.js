import { z } from 'zod'
import { query } from '../db/pool.js'
import { listWorkers, SEARCH_MIN, searchWorkers, workerAccessFor } from '../lib/workers.js'

export const workersQuerySchema = z.object({
  q: z.string().trim().max(60).optional(),
})

/**
 * The caller's colleagues, for the "about whom" picker on a custom Hook.
 *
 * Two shapes, decided by workerAccessFor:
 *   mode 'full'    the whole list, once - the client filters as you type
 *   mode 'search'  nothing until `q` has SEARCH_MIN letters, then up to ten
 *                  names matching it
 *
 * No access at all is a normal answer, not an error: the form then falls
 * back to typing a name. `reason` says why, so the client can explain.
 */
export async function getWorkers(req, res) {
  const access = await workerAccessFor(req.user.id)

  if (!access) {
    return res.json({ available: false, reason: 'no_organization', organization: null, workers: [] })
  }

  const { rows: org } = await query('select name from public.organizations where id = $1', [
    access.organizationId,
  ])
  const organization = org[0]?.name ?? null

  if (access.mode === 'search') {
    const q = req.validatedQuery.q ?? ''
    const workers = q.length >= SEARCH_MIN
      ? await searchWorkers(access.organizationId, q, req.user.id)
      : []
    return res.json({ available: true, mode: 'search', minLength: SEARCH_MIN, organization, workers })
  }

  const workers = await listWorkers(access.organizationId, req.user.id)
  res.json({
    available: true,
    mode: 'full',
    reason: workers.length ? null : 'empty',
    organization,
    workers,
  })
}
