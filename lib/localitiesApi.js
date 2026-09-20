/**
 * Israeli localities (יישובים), from the CBS list published on data.gov.il.
 *
 * Unlike the company registry this list is small - about 1,300 rows - so the
 * whole thing is fetched once and searched in memory. One upstream call an
 * hour instead of one per keystroke, and the autocomplete answers instantly.
 *
 * The dataset carries no coordinates, so a locality cannot be derived from a
 * GPS fix here. `localityFromCoords` reverse-geocodes through Nominatim and
 * then matches the name it returns back onto this list, so what we store is
 * always an official name and code rather than whatever a geocoder called it.
 */
import { AppError } from './AppError.js'

const CKAN = 'https://data.gov.il/api/3/action/datastore_search'
const LOCALITIES_RESOURCE = '5c78e9fa-c2e2-4771-93ff-7f400a12f7ba'

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse'
// Nominatim's usage policy requires an identifying User-Agent and at most one
// request a second. Both are honoured here; the cache does most of the work.
const USER_AGENT = 'Equalmind/1.0 (https://equalmind.app)'

const TIMEOUT_MS = 10_000
const LIST_TTL_MS = 6 * 60 * 60 * 1000 // the list changes a few times a year
const GEO_TTL_MS = 24 * 60 * 60 * 1000
const GEO_CACHE_MAX = 500

/** Placeholder rows in the source that are not real localities. */
const NOT_A_PLACE = /^(לא רשום|לא ידוע|אחר)$/

function str(value) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text === '' || text === 'None' ? null : text
}

/**
 * Hebrew locality names vary by separator between sources. CBS writes
 * "תל אביב - יפו" with spaces and an ASCII hyphen; a geocoder returns
 * "תל־אביב–יפו" with a maqaf (U+05BE) and an en dash. Every one of those
 * becomes a space here, so both sides reduce to "תל אביב יפו".
 *
 * The maqaf in particular is easy to miss - it is a Hebrew punctuation
 * character, not a hyphen, so a class of ASCII dashes does not catch it and
 * the country's largest city silently stops matching.
 */
export function normalizeLocality(text) {
  if (!text) return ''
  return String(text)
    .replace(/[~"'״׳()־‐‑‒\-–—.,|/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/* ------------------------------------------------------------------ fetch */

async function getJson(url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers })
    if (!response.ok) throw new Error(`upstream ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------- the list */

let listCache = { at: 0, rows: null }
let inFlight = null

async function fetchList() {
  const url = `${CKAN}?resource_id=${LOCALITIES_RESOURCE}&limit=32000`
  const body = await getJson(url)
  if (!body?.success) throw new Error('datastore_search returned success: false')

  return body.result.records
    .map((r) => ({
      code: str(r['סמל_ישוב']),
      name: str(r['שם_ישוב']),
      nameEn: str(r['שם_ישוב_לועזי']),
      district: str(r['שם_נפה']),
      council: str(r['שם_מועצה']),
    }))
    .filter((l) => l.name && l.code && l.code !== '0' && !NOT_A_PLACE.test(l.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'))
}

/**
 * The cached list, or null when the source is unreachable and we have no
 * copy yet. A stale copy is preferred over an error: a locality list that
 * briefly lags reality is better than a form that cannot be submitted.
 */
async function loadList() {
  const fresh = listCache.rows && Date.now() - listCache.at < LIST_TTL_MS
  if (fresh) return { rows: listCache.rows, degraded: false, cached: true }

  // Collapse concurrent refreshes into one upstream call.
  inFlight ??= fetchList()
    .then((rows) => {
      listCache = { at: Date.now(), rows }
      return rows
    })
    .finally(() => {
      inFlight = null
    })

  try {
    return { rows: await inFlight, degraded: false, cached: false }
  } catch (error) {
    console.error('[localities] refresh failed:', error.message)
    // Serve the stale copy if we have one.
    return { rows: listCache.rows, degraded: true, cached: Boolean(listCache.rows) }
  }
}

/* ------------------------------------------------------------------ search */

/**
 * Ranked locally: exact first, then prefix, then contains, shorter names
 * ahead of longer ones. "חיפה" should not sit below "חיפה - מפרץ".
 */
export async function searchLocalities(q, { limit = 8 } = {}) {
  const { rows, degraded, cached } = await loadList()
  if (!rows) return { results: [], degraded: true, cached: false }

  const needle = normalizeLocality(q)
  if (!needle) return { results: [], degraded, cached }

  const scored = []
  for (const locality of rows) {
    const hay = normalizeLocality(locality.name)
    const hayEn = (locality.nameEn ?? '').toLowerCase()

    let rank
    if (hay === needle) rank = 0
    else if (hay.startsWith(needle)) rank = 1
    else if (hay.includes(needle)) rank = 2
    else if (hayEn && hayEn.startsWith(needle)) rank = 3
    else continue

    scored.push({ locality, rank })
  }

  scored.sort((a, b) => a.rank - b.rank || a.locality.name.length - b.locality.name.length)

  return { results: scored.slice(0, limit).map((s) => s.locality), degraded, cached }
}

/** Exact lookup by the official CBS code, for validating a submitted value. */
export async function findLocalityByCode(code) {
  const { rows, cached } = await loadList()
  if (!rows) return { locality: null, cached: false }
  return { locality: rows.find((l) => l.code === String(code)) ?? null, cached }
}

/* -------------------------------------------------------- reverse geocode */

const geoCache = new Map()

function geoKey(lat, lon) {
  // ~1km buckets. Finer than that would cache almost nothing, and the answer
  // is a locality name - it does not change within a kilometre.
  return `${lat.toFixed(2)},${lon.toFixed(2)}`
}

/**
 * Turn a browser GPS fix into an official locality.
 *
 * Nominatim names the place; this list decides what that place officially is.
 * If the name it returns matches nothing, we return the raw name with a null
 * code rather than guessing - a wrong locality on a report is worse than an
 * unmatched one.
 */
export async function localityFromCoords(lat, lon) {
  const key = geoKey(lat, lon)
  const hit = geoCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return { ...hit.value, cached: true }

  let place
  try {
    const url =
      `${NOMINATIM}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=he`
    const body = await getJson(url, { 'User-Agent': USER_AGENT })
    const a = body?.address ?? {}
    place = str(a.city ?? a.town ?? a.village ?? a.municipality ?? a.county)
  } catch (error) {
    console.error('[localities] reverse geocode failed:', error.message)
    throw new AppError(
      502,
      'geocode_failed',
      'זיהוי המיקום נכשל. אפשר לבחור יישוב מהרשימה.',
    )
  }

  if (!place) return { locality: null, matched: false, cached: false }

  const { rows } = await loadList()
  const needle = normalizeLocality(place)
  const match =
    rows?.find((l) => normalizeLocality(l.name) === needle) ??
    rows?.find((l) => normalizeLocality(l.name).startsWith(needle)) ??
    null

  const value = {
    locality: match ?? { code: null, name: place, nameEn: null, district: null, council: null },
    matched: Boolean(match),
  }

  if (geoCache.size >= GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value)
  geoCache.set(key, { value, expiresAt: Date.now() + GEO_TTL_MS })

  return { ...value, cached: false }
}
