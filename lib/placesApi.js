/**
 * Business search for the consumption-space form ("שם העסק").
 *
 * Photon (photon.komoot.io): OpenStreetMap data, free, no key, and - unlike
 * Nominatim - it explicitly supports search-as-you-type. Nominatim's usage
 * policy forbids autocomplete, which is why localitiesApi cannot be reused
 * for this.
 *
 * The one place a provider is named, like mediaProvider: moving to Google
 * Places (better coverage of small Israeli businesses, but a paid key) means
 * replacing `searchPhoton` and nothing else.
 *
 * WHAT LEAVES THE SERVER: the typed text, and - only if the reporter pressed
 * "use my location" - a position ROUNDED TO ~1KM. Enough to rank nearby
 * branches first; not enough to place a person. Nothing is stored.
 *
 * A failure is `degraded: true`, never thrown: the reporter can always type
 * the business name by hand, so a search outage must not block a report.
 */

const PHOTON = 'https://photon.komoot.io/api/'
const USER_AGENT = 'Equalmind/1.0 (https://equalmind.app)'
const TIMEOUT_MS = 6_000
const TTL_MS = 60 * 60 * 1000
const CACHE_MAX = 1_000
const LIMIT = 8

// Israel, as minLon,minLat,maxLon,maxLat - keeps "סופר" from matching Ohio.
const ISRAEL_BBOX = '34.2,29.45,35.95,33.35'

// What a business is in OSM. Places, streets and regions are left out: the
// field asks for a business, and the free-text "where" field covers the rest.
const BUSINESS_KEYS = new Set([
  'shop', 'amenity', 'office', 'craft', 'tourism', 'leisure', 'healthcare',
])

const cache = new Map()

/** ~1km: two decimal places of a degree. */
const coarse = (value) => Math.round(value * 100) / 100

export async function searchPlaces(term, { lat, lon } = {}) {
  const q = term.trim()
  const near = lat != null && lon != null ? { lat: coarse(lat), lon: coarse(lon) } : null
  const key = `${q.toLowerCase()}|${near ? `${near.lat},${near.lon}` : ''}`

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return { results: hit.results, degraded: false }

  try {
    const results = await searchPhoton(q, near)
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(key, { at: Date.now(), results })
    return { results, degraded: false }
  } catch (error) {
    console.warn('[places] search failed:', error.message)
    return { results: [], degraded: true }
  }
}

async function searchPhoton(q, near) {
  const params = new URLSearchParams({ q, limit: String(LIMIT * 2), bbox: ISRAEL_BBOX })
  if (near) {
    params.set('lat', String(near.lat))
    params.set('lon', String(near.lon))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${PHOTON}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`photon ${response.status}`)
    const body = await response.json()

    return (body.features ?? [])
      .map(({ properties: p = {} }) => p)
      .filter((p) => p.name && BUSINESS_KEYS.has(p.osm_key))
      .slice(0, LIMIT)
      .map((p) => ({
        // Stable across searches, so a pick can be recognised again.
        id: `${p.osm_type ?? ''}${p.osm_id ?? ''}`,
        name: p.name,
        address: [[p.street, p.housenumber].filter(Boolean).join(' '), p.city]
          .filter(Boolean)
          .join(', ') || null,
        city: p.city ?? p.town ?? p.village ?? null,
      }))
  } finally {
    clearTimeout(timer)
  }
}
