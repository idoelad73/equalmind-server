/**
 * Israeli organisation lookup, proxied from data.gov.il.
 *
 * Two public CKAN datasets:
 *   רשם החברות             ~730,000 companies
 *   רשם העמותות / חל"צ      ~76,000 non-profits
 *
 * Proxied rather than mirrored locally: mirroring meant ~806k rows plus GIN
 * trigram indexes, which would have eaten the whole free-tier database for a
 * lookup used a handful of times a week. See migration 006.
 *
 * Two things this layer adds over calling CKAN directly from the client:
 *   - a short in-memory cache, so repeated lookups are instant and the
 *     government portal is not hit per keystroke
 *   - normalisation and ranking, because the source data is dirty and CKAN
 *     returns matches in no useful order
 */

const DATASETS = {
  companies: {
    resourceId: 'f004176c-b85f-4542-8901-7b3176f9a054',
    map: (r) => ({
      id: str(r['מספר חברה']),
      source: 'companies',
      name: str(r['שם חברה']),
      nameEn: str(r['שם באנגלית']),
      entityType: str(r['סוג תאגיד']),
      status: str(r['סטטוס חברה']),
      isActive: str(r['סטטוס חברה']) === 'פעילה',
      city: str(r['שם עיר']),
      street: str(r['שם רחוב']),
      houseNumber: str(r['מספר בית']),
      postalCode: str(r['מיקוד']),
      registeredOn: isoDate(r['תאריך התאגדות']),
    }),
  },
  nonprofits: {
    resourceId: 'be5b7935-3922-45d4-9638-08871b17ec95',
    map: (r) => ({
      id: str(r['מספר עמותה']),
      source: 'nonprofits',
      name: str(r['שם עמותה בעברית']),
      nameEn: str(r['שם עמותה באנגלית']),
      entityType: str(r['סיווג פעילות ענפי']),
      status: str(r['סטטוס עמותה']),
      isActive: str(r['סטטוס עמותה']) === 'רשומה',
      city: str(r['כתובת - ישוב']),
      street: str(r['כתובת - רחוב']),
      houseNumber: str(r['כתובת - מספר דירה']),
      postalCode: str(r['כתובת - מיקוד']),
      registeredOn: isoDate(r['תאריך רישום עמותה']),
    }),
  },
}

const CKAN = 'https://data.gov.il/api/3/action/datastore_search'
const TIMEOUT_MS = 8000
const CACHE_TTL_MS = 60 * 60 * 1000 // an hour; these registries change slowly
const CACHE_MAX = 500

/** The source stores blanks as '' and as the literal string 'None'. */
function str(value) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text === '' || text === 'None' ? null : text
}

function isoDate(value) {
  const text = str(value)
  const m = text?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

/**
 * Registry names are messy: a tilde stands in for a geresh, brackets and
 * punctuation are inconsistent, and runs of spaces are common - the registry
 * stores "טבע נאות (2020)   בע~מ". Comparing anything against that raw fails,
 * so both sides go through this first.
 */
export function normalizeOrgName(text) {
  if (!text) return ''
  return String(text)
    .toLowerCase()
    .replace(/[~"'״׳()\-–—.,|/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ cache */

const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  // Refresh insertion order so the least recently used falls off first.
  cache.delete(key)
  cache.set(key, hit)
  return hit.value
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

/* ------------------------------------------------------------------ fetch */

async function ckan(params) {
  const url = `${CKAN}?${new URLSearchParams(params)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`data.gov.il returned ${res.status}`)
  const body = await res.json()
  if (!body.success) throw new Error('data.gov.il reported failure')
  return body.result.records ?? []
}

/* ----------------------------------------------------------------- search */

/**
 * Ranks a match the way a person would expect: the thing they typed, then
 * things starting with it, then things containing it - shorter names first,
 * so "טבע" surfaces טבע itself rather than one of the hundreds of companies
 * whose name merely contains it.
 */
function score(row, needle) {
  const name = normalizeOrgName(row.name)
  const nameEn = normalizeOrgName(row.nameEn)

  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  if (nameEn && nameEn.startsWith(needle)) return 2
  if (name.includes(needle)) return 3
  return 4
}

export async function searchOrganizations(q, { limit = 8, activeOnly = true } = {}) {
  const needle = normalizeOrgName(q)
  if (needle.length < 2) return { results: [], degraded: false }

  const key = `s|${needle}|${limit}|${activeOnly}`
  const cached = cacheGet(key)
  if (cached) return { ...cached, cached: true }

  // Both registries in parallel; over-fetch so local ranking has something to
  // work with, since CKAN returns matches in no meaningful order.
  const settled = await Promise.allSettled(
    Object.entries(DATASETS).map(async ([, ds]) => {
      const records = await ckan({ resource_id: ds.resourceId, q, limit: 60 })
      return records.map(ds.map)
    }),
  )

  const rows = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))

  // If every dataset failed the caller should know the answer is unreliable,
  // so the form can fall back to a plain text field instead of implying the
  // organisation does not exist.
  const degraded = settled.every((s) => s.status === 'rejected')
  if (degraded) return { results: [], degraded: true }

  const results = rows
    .filter((r) => r.id && r.name)
    .filter((r) => !activeOnly || r.isActive)
    .map((r) => ({ ...r, _score: score(r, needle) }))
    .filter((r) => r._score < 4)
    .sort((a, b) => a._score - b._score || a.name.length - b.name.length)
    .slice(0, limit)
    .map(({ _score, ...row }) => row)

  const value = { results, degraded: false }
  cacheSet(key, value)
  return value
}

/** Exact lookup by ח.פ or מספר עמותה, to confirm what a user typed. */
export async function findOrganizationById(id) {
  const key = `id|${id}`
  const cached = cacheGet(key)
  if (cached) return { ...cached, cached: true }

  for (const [name, ds] of Object.entries(DATASETS)) {
    const field = name === 'companies' ? 'מספר חברה' : 'מספר עמותה'
    try {
      const records = await ckan({
        resource_id: ds.resourceId,
        filters: JSON.stringify({ [field]: id }),
        limit: 1,
      })
      if (records.length) {
        const value = { company: ds.map(records[0]), degraded: false }
        cacheSet(key, value)
        return value
      }
    } catch {
      // Try the other registry before giving up.
    }
  }

  return { company: null, degraded: false }
}
