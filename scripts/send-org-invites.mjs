/**
 * Send organisation admin invitations. Nothing else.
 *
 * The invitee lands on the org admin registration form and declares the
 * organisation there - its name, industry, registration number, size and
 * address. So this script creates no organisation and fills in nothing the
 * form is going to ask for. It sends the mail.
 *
 *   node scripts/send-org-invites.mjs --email admin@company.co.il [--dry-run]
 *   node scripts/send-org-invites.mjs --file scripts/emails.csv   [--dry-run]
 *
 *   --file <path>    CSV with an `email` column. Other columns are ignored.
 *   --dry-run        print the plan, send nothing, write nothing
 *   --delay-ms <n>   pause between sends (default 1500), for the rate limit
 *   --limit <n>      stop after n invitations
 *   --out <path>     write a CSV of per-row results
 *
 * The one thing it does besides sending: marks the new account org_admin,
 * with the service role, using the id inviteUserByEmail returns. That has to
 * happen here. If the registration form granted the role instead, anyone who
 * reached the form could promote themselves - which is the entire thing
 * invite-only exists to prevent.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { supabaseAdmin } from '../db/supabase.js'
import { query, pool } from '../db/pool.js'
import { env } from '../config/env.js'

const REDIRECT_TO = `${env.clientOrigins[0]}/invite/accept`
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') { out.dryRun = true; continue }
    if (!arg.startsWith('--')) continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) continue
    out[arg.slice(2)] = value
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const delayMs = Number(args['delay-ms'] ?? 1500)
const limit = args.limit ? Number(args.limit) : Infinity

if (!args.email && !args.file) {
  console.error(
    'Usage:\n' +
      '  node scripts/send-org-invites.mjs --email <address> [--dry-run]\n' +
      '  node scripts/send-org-invites.mjs --file <path.csv> [--dry-run]',
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

function loadEmails() {
  if (args.email) return [args.email.trim().toLowerCase()]
  const rows = parseCsv(readFileSync(args.file, 'utf8'))
  if (rows.length && !('email' in rows[0])) {
    throw new Error(`${args.file} has no "email" column`)
  }
  return rows.map((r) => (r.email ?? '').trim().toLowerCase())
}

/* ------------------------------------------------------------ operations */

/**
 * Re-inviting an address that already has an account would mail a fresh
 * confirmation link for an account someone is already using, so check first.
 */
async function currentType(email) {
  const { rows } = await query(
    `select p.user_type
       from auth.users u
       join public.profiles p on p.id = u.id
      where lower(u.email) = $1`,
    [email],
  )
  return rows[0]?.user_type ?? null
}

async function inviteOne(email) {
  const existing = await currentType(email)
  if (existing === 'org_admin') return { status: 'skipped', detail: 'already an org admin' }
  if (existing) return { status: 'skipped', detail: 'already has an account - delete it first' }

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: REDIRECT_TO,
  })

  if (error) {
    // Worth its own outcome: the batch should stop rather than burn through
    // the remaining addresses failing the same way.
    const rateLimited = /rate limit|too many/i.test(error.message)
    return { status: rateLimited ? 'rate_limited' : 'failed', detail: error.message }
  }

  await query(`update public.profiles set user_type = 'org_admin' where id = $1`, [data.user.id])

  return { status: 'invited', detail: data.user.id }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const all = loadEmails()
  const valid = all.filter((e) => EMAIL_RE.test(e))
  const invalid = all.filter((e) => !EMAIL_RE.test(e))
  const planned = valid.slice(0, limit)

  console.log(`source        ${args.file ?? args.email}`)
  console.log(`rows          ${all.length}  (${planned.length} to send, ${invalid.length} invalid)`)
  console.log(`invite opens  ${REDIRECT_TO}`)
  console.log(`delay         ${delayMs}ms between sends\n`)

  for (const bad of invalid) console.log(`  SKIP         ${bad || '(blank)'}  invalid email`)

  if (args.dryRun) {
    for (const email of planned) {
      const existing = await currentType(email)
      console.log(`  PLAN         ${email}${existing ? `   [would skip: ${existing}]` : ''}`)
    }
    console.log('\nDry run - nothing sent, nothing written.')
    return
  }

  const results = []
  for (const [index, email] of planned.entries()) {
    const outcome = await inviteOne(email)
    results.push({ email, ...outcome })
    console.log(`  ${outcome.status.toUpperCase().padEnd(12)} ${email.padEnd(34)} ${outcome.detail}`)

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
    const csv = ['email,status,detail']
      .concat(
        results.map(
          (r) => `"${r.email}",${r.status},"${String(r.detail).replace(/"/g, '""')}"`,
        ),
      )
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
