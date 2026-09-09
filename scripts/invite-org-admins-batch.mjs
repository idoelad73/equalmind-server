/**
 * Invite organisation admins in bulk.
 *
 *   node scripts/invite-org-admins-batch.mjs --file invites.csv [--dry-run]
 *   node scripts/invite-org-admins-batch.mjs --from-requests    [--dry-run]
 *
 * Two sources:
 *   --file <path>     a CSV you prepare. Columns (header row required):
 *                       org_name,email[,full_name,mobile,industry,
 *                        company_number,employees]
 *   --from-requests   every pending row in org_registration_requests.
 *                     Each invited request is marked 'approved'.
 *
 * Other flags:
 *   --dry-run         print the plan, change nothing, send nothing
 *   --delay-ms <n>    pause between sends (default 1500) to stay under the
 *                     provider's rate limit
 *   --limit <n>       stop after n invitations
 *   --out <path>      write a CSV of per-row results
 *
 * Prefer the CSV over command-line arguments for Hebrew organisation names:
 * the file is read as UTF-8, whereas Windows mangles non-ASCII argv unless the
 * console codepage is set to 65001.
 *
 * Every row is independent. A failure is recorded and the run continues, so
 * one bad address cannot abandon the rest of the batch half-sent.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { supabaseAdmin } from '../db/supabase.js'
import { query, pool } from '../db/pool.js'
import { env } from '../config/env.js'

const REDIRECT_TO = `${env.clientOrigins[0]}/invite/accept`

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { dryRun: false, delayMs: 1500 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') { out.dryRun = true; continue }
    if (arg === '--from-requests') { out.fromRequests = true; continue }
    if (!arg.startsWith('--')) continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) continue
    out[arg.slice(2)] = value
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const delayMs = Number(args['delay-ms'] ?? args.delayMs ?? 1500)
const limit = args.limit ? Number(args.limit) : Infinity

if (!args.file && !args.fromRequests) {
  console.error(
    'Usage:\n' +
      '  node scripts/invite-org-admins-batch.mjs --file invites.csv [--dry-run]\n' +
      '  node scripts/invite-org-admins-batch.mjs --from-requests    [--dry-run]',
  )
  process.exit(1)
}

/* ------------------------------------------------------------------- csv */

/** Minimal RFC-4180 reader: quoted fields, embedded commas, CRLF, BOM. */
function parseCsv(text) {
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

/* ----------------------------------------------------------------- input */

async function loadRows() {
  if (args.file) {
    return parseCsv(readFileSync(args.file, 'utf8')).map((r) => ({
      source: 'csv',
      orgName: r.org_name,
      email: (r.email ?? '').toLowerCase(),
      fullName: r.full_name || null,
      mobile: r.mobile || null,
      industry: r.industry || null,
      companyNumber: r.company_number || null,
      employeeCount: r.employees ? Number(r.employees) : null,
    }))
  }

  const { rows } = await query(
    `select id, org_name, contact_email, full_name, mobile, industry,
            company_number, employee_count
       from public.org_registration_requests
      where status = 'pending'
      order by created_at`,
  )
  return rows.map((r) => ({
    source: 'request',
    requestId: r.id,
    orgName: r.org_name,
    email: (r.contact_email ?? '').toLowerCase(),
    fullName: r.full_name,
    mobile: r.mobile,
    industry: r.industry,
    companyNumber: r.company_number,
    employeeCount: r.employee_count,
  }))
}

/* ------------------------------------------------------------ operations */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ensureOrganization(row) {
  const { rows: found } = await query(
    'select * from public.organizations where lower(name) = lower($1)',
    [row.orgName],
  )
  if (found.length) return { org: found[0], created: false }

  const { rows } = await query(
    `insert into public.organizations (name, industry, company_number, employee_count)
     values ($1,$2,$3,$4) returning *`,
    [row.orgName, row.industry, row.companyNumber, row.employeeCount],
  )
  return { org: rows[0], created: true }
}

async function alreadyAdmin(email) {
  const { rows } = await query(
    `select o.name from public.org_admins a
       join public.organizations o on o.id = a.organization_id
       join auth.users u on u.id = a.user_id
      where lower(u.email) = $1`,
    [email],
  )
  return rows[0]?.name ?? null
}

async function inviteOne(row) {
  const existing = await alreadyAdmin(row.email)
  if (existing) return { status: 'skipped', detail: `already administers "${existing}"` }

  const { org, created } = await ensureOrganization(row)

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(row.email, {
    redirectTo: REDIRECT_TO,
    data: { organization_name: org.name },
  })

  if (error) {
    // Rate limiting is worth surfacing as its own outcome: the batch should
    // stop rather than burn through the remaining addresses failing.
    const rateLimited = /rate limit|too many/i.test(error.message)
    return { status: rateLimited ? 'rate_limited' : 'failed', detail: error.message }
  }

  const userId = data.user.id

  await query(
    `insert into public.org_admins
       (user_id, organization_id, full_name, mobile, contact_email)
     values ($1,$2,$3,$4,$5)
     on conflict (user_id) do update
       set organization_id = excluded.organization_id, updated_at = now()`,
    [userId, org.id, row.fullName, row.mobile, row.email],
  )
  await query(`update public.profiles set user_type = 'org_admin' where id = $1`, [userId])

  if (row.requestId) {
    await query(
      `update public.org_registration_requests
          set status = 'approved', handled_at = now()
        where id = $1`,
      [row.requestId],
    )
  }

  return { status: 'invited', detail: created ? 'organisation created' : 'organisation reused' }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const all = await loadRows()

  const valid = []
  const invalid = []
  for (const row of all) {
    if (!row.orgName) invalid.push({ ...row, reason: 'missing org_name' })
    else if (!EMAIL_RE.test(row.email)) invalid.push({ ...row, reason: 'invalid email' })
    else valid.push(row)
  }

  const planned = valid.slice(0, limit)

  console.log(`source        ${args.file ? args.file : 'pending requests'}`)
  console.log(`rows          ${all.length}  (${planned.length} to process, ${invalid.length} invalid)`)
  console.log(`redirect      ${REDIRECT_TO}`)
  console.log(`delay         ${delayMs}ms between sends\n`)

  for (const bad of invalid) {
    console.log(`  SKIP  ${bad.email || '(no email)'}  ${bad.reason}`)
  }

  if (args.dryRun) {
    for (const row of planned) {
      const existing = await alreadyAdmin(row.email)
      console.log(
        `  PLAN  ${row.email.padEnd(34)} ${row.orgName}` +
          (existing ? `   [would skip: already administers "${existing}"]` : ''),
      )
    }
    console.log('\nDry run - nothing sent, nothing written.')
    return
  }

  const results = []
  for (const [index, row] of planned.entries()) {
    const outcome = await inviteOne(row)
    results.push({ email: row.email, org: row.orgName, ...outcome })
    console.log(`  ${outcome.status.toUpperCase().padEnd(12)} ${row.email.padEnd(34)} ${outcome.detail}`)

    if (outcome.status === 'rate_limited') {
      console.log('\nStopped: the mail provider is rate limiting.')
      console.log('Remaining rows were not touched - re-run to continue where it left off.')
      break
    }
    if (index < planned.length - 1) await sleep(delayMs)
  }

  const tally = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})
  console.log('\nsummary:', JSON.stringify(tally))

  if (args.out) {
    const csv = ['email,org,status,detail']
      .concat(results.map((r) => `"${r.email}","${r.org}",${r.status},"${String(r.detail).replace(/"/g, '""')}"`))
      .join('\n')
    writeFileSync(args.out, '﻿' + csv, 'utf8')
    console.log(`results written to ${args.out}`)
  }
}

main()
  .catch((error) => {
    console.error('\nFAILED:', error.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())
