import { z } from 'zod'
import { findOrganizationById, searchOrganizations } from '../lib/registryApi.js'

export const lookupSchema = z.object({
  q: z.string().trim().min(2, 'נדרשים לפחות 2 תווים').max(80),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  activeOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
})

export const byIdSchema = z.object({
  id: z.string().trim().regex(/^\d{5,15}$/, 'מספר לא תקין'),
})

/**
 * Organisation autocomplete, proxied from data.gov.il.
 *
 * `degraded: true` means the registry could not be reached. It is reported
 * rather than raised so the form can fall back to a plain text field - an
 * error here would wrongly suggest the organisation does not exist.
 */
export async function getCompanies(req, res) {
  const { q, limit, activeOnly } = req.validatedQuery
  const { results, degraded, cached } = await searchOrganizations(q, { limit, activeOnly })

  res.json({ query: q, count: results.length, degraded: Boolean(degraded), cached: Boolean(cached), results })
}

export async function getCompanyById(req, res) {
  const { company, cached } = await findOrganizationById(req.validatedQuery.id)
  res.json({ found: Boolean(company), cached: Boolean(cached), company })
}
