/**
 * Parsing and applying an employee roster.
 *
 * Shared by the CLI script and the upload endpoint, so a roster behaves the
 * same however it arrives. Two copies of this would drift, and the drift
 * would be silent: rows that import from one path and skip from the other.
 *
 * THE FILE HAS NO ORGANISATION COLUMN. The organisation comes from the
 * caller - the admin's own for an upload, `--org-id` for the CLI - because a
 * name typed into a spreadsheet is the one thing that reliably fails to
 * match a registry name. "אמדוקס (ישראל) בע~מ" has a tilde standing in for a
 * geresh, and nobody types that twice the same way.
 */
import { hashPhone } from './rosterHash.js'
import { normalizePhone } from './phone.js'

/** Columns we accept for each field, so a hand-made file still works. */
const NAME_KEYS = ['full_name', 'name', 'employee_name', 'שם', 'שם מלא']
const PHONE_KEYS = ['phone', 'mobile', 'employee_phone', 'טלפון', 'נייד']

/** Minimal RFC-4180 reader: quoted fields, embedded commas, CRLF, BOM. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const clean = text.replace(/^﻿/, '')

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''))
  if (!header) return []

  const keys = header.map((h) => h.trim().toLowerCase())
  return body.map((cells) =>
    Object.fromEntries(keys.map((k, idx) => [k, (cells[idx] ?? '').trim()])),
  )
}

const pick = (row, keys) => {
  for (const key of keys) if (row[key]) return row[key]
  return ''
}

/**
 * CSV text to a plan, without touching the database.
 *
 * Every row comes back either planned or skipped with a reason, so the
 * modal can show exactly what will happen before anything is written.
 */
export function planRoster(text, organizationId) {
  const rows = parseCsv(text)

  if (!rows.length) {
    return { planned: [], skipped: [], error: 'הקובץ ריק או שאינו מכיל שורת כותרות.' }
  }

  const header = Object.keys(rows[0])
  const hasName = NAME_KEYS.some((k) => header.includes(k))
  const hasPhone = PHONE_KEYS.some((k) => header.includes(k))

  if (!hasPhone) {
    return {
      planned: [],
      skipped: [],
      error: 'לא נמצאה עמודת טלפון. הכותרות הנדרשות הן full_name ו-phone.',
    }
  }

  const planned = []
  const skipped = []
  const seen = new Map()

  for (const [index, row] of rows.entries()) {
    const line = index + 2 // the header is line 1
    const fullName = pick(row, NAME_KEYS) || null
    const raw = pick(row, PHONE_KEYS)
    const e164 = normalizePhone(raw)

    if (!e164) {
      skipped.push({ line, fullName, reason: 'מספר נייד ישראלי לא תקין' })
      continue
    }
    if (seen.has(e164)) {
      skipped.push({ line, fullName, reason: `מספר זהה לשורה ${seen.get(e164)}` })
      continue
    }
    seen.set(e164, line)

    planned.push({
      line,
      organizationId,
      fullName,
      phoneHash: hashPhone(e164),
      // Held in memory only, to attach accounts that already exist.
      // Never stored, never logged, never returned to the client.
      e164,
      masked: maskPhone(e164),
    })
  }

  return { planned, skipped, error: null, hasName }
}

/** Never show a whole number: `+97250***567`. */
export function maskPhone(e164) {
  return e164 ? `${e164.slice(0, 7)}***${e164.slice(-3)}` : '—'
}

/**
 * Write a plan.
 *
 * `query` is passed in rather than imported so the caller decides whether
 * this runs inside a transaction.
 */
export async function applyRoster(planned, query) {
  const results = []
  let attached = 0

  for (const p of planned) {
    // phone_hash is unique globally: one person, one employer. A number on
    // another organisation's roster is reported rather than moved, because
    // silently reassigning somebody is exactly what nobody would notice.
    const { rows: existing } = await query(
      `select r.organization_id, o.name
         from public.org_rosters r
         join public.organizations o on o.id = r.organization_id
        where r.phone_hash = $1`,
      [p.phoneHash],
    )

    if (existing.length && existing[0].organization_id !== p.organizationId) {
      results.push({
        line: p.line,
        fullName: p.fullName,
        masked: p.masked,
        status: 'conflict',
        detail: `כבר מופיע ברשימה של "${existing[0].name}"`,
      })
      continue
    }

    if (existing.length) {
      await query(
        `update public.org_rosters
            set employee_name = coalesce($2, employee_name)
          where phone_hash = $1`,
        [p.phoneHash, p.fullName],
      )
      results.push({
        line: p.line, fullName: p.fullName, masked: p.masked,
        status: 'already_listed', detail: 'כבר ברשימה',
      })
    } else {
      await query(
        `insert into public.org_rosters (organization_id, phone_hash, employee_name)
         values ($1, $2, $3)`,
        [p.organizationId, p.phoneHash, p.fullName],
      )
      results.push({
        line: p.line, fullName: p.fullName, masked: p.masked,
        status: 'added', detail: 'נוסף',
      })
    }

    // Someone who already signed up with this number is attached now rather
    // than waiting for them to enter it again. Matched on profiles.phone,
    // which is plaintext because that person typed it themselves.
    const { rowCount } = await query(
      `update public.profiles
          set organization_id = $1, org_source = 'roster'
        where phone = $2
          and (organization_id is distinct from $1 or org_source is distinct from 'roster')`,
      [p.organizationId, p.e164],
    )

    if (rowCount) {
      attached += 1
      await query(
        `update public.org_rosters
            set claimed_at = coalesce(claimed_at, now()),
                claimed_by = (select id from public.profiles where phone = $2)
          where phone_hash = $1`,
        [p.phoneHash, p.e164],
      )
    }
  }

  return { results, attached }
}

/** Counts by status, for a summary line. */
export const tally = (results) =>
  results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})
