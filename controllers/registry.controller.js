import { z } from 'zod'
import { findOrganizationById, searchOrganizations } from '../lib/registryApi.js'
import { localityFromCoords, searchLocalities } from '../lib/localitiesApi.js'

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

/* --------------------------------------------------------------- localities */

export const localitySearchSchema = z.object({
  q: z.string().trim().min(1, 'נדרש לפחות תו אחד').max(60),
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

export const localityCoordsSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
})

/** Locality autocomplete for the report form. Same degraded contract. */
export async function getLocalities(req, res) {
  const { q, limit } = req.validatedQuery
  const { results, degraded, cached } = await searchLocalities(q, { limit })

  res.json({
    query: q,
    count: results.length,
    degraded: Boolean(degraded),
    cached: Boolean(cached),
    results,
  })
}

/**
 * Resolve a browser GPS fix to an official locality.
 *
 * `matched: false` means a geocoder named the place but it is not on the CBS
 * list, so `locality.code` is null. The client shows the name and lets the
 * reporter confirm rather than silently filing an unofficial one.
 */
export async function getLocalityByCoords(req, res) {
  const { lat, lon } = req.validatedQuery
  const { locality, matched, cached } = await localityFromCoords(lat, lon)

  res.json({ found: Boolean(locality), matched: Boolean(matched), cached: Boolean(cached), locality })
}
