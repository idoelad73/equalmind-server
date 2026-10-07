/**
 * Import an organisation's employee roster from the command line.
 *
 *   node scripts/import-org-roster.mjs --file roster.xlsx --org-id <uuid> [--dry-run]
 *   node scripts/import-org-roster.mjs --file roster.csv --registry 511251217
 *
 * .xlsx or .csv, header row required - the same reader as the upload:
 *
 *   שם, טלפון        required (full_name, phone also accepted)
 *   מחלקה, תפקיד     optional (department, job_title)
 *
 * THERE IS NO ORGANISATION COLUMN. The organisation is named once, by flag,
 * because a name typed into a spreadsheet is the one thing that reliably
 * fails to match a registry name - "אמדוקס (ישראל) בע~מ" carries a tilde
 * standing in for a geresh, and nobody types that twice the same way.
 *
 * Org admins do this from the app instead (התנתקות menu -> טען רשימת עובדים),
 * where the organisation is their own and cannot be chosen at all. This
 * script is for staff loading a roster on someone's behalf.
 *
 * Flags:
 *   --org-id <uuid>      the organisation to load into
 *   --registry <number>  or name it by registration number
 *   --dry-run            parse and report, write nothing
 *   --out <path>         CSV of per-row outcomes
 *
 * WHAT IS STORED: an HMAC of each phone number (the matching key), the
 * number itself in E.164 (since migration 015), the name, and the optional
 * department and job title. Numbers are never printed here - output is
 * masked, because imports get run in shared terminals.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { query, withTransaction, pool } from '../db/pool.js'
import { env } from '../config/env.js'
import { applyRoster, planRoster, readRosterFile, tally } from '../lib/rosterImport.js'

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

if (!args.file || (!args['org-id'] && !args.registry)) {
  console.error(
    'Usage:\n' +
      '  node scripts/import-org-roster.mjs --file roster.xlsx --org-id <uuid> [--dry-run]\n' +
      '  node scripts/import-org-roster.mjs --file roster.csv --registry <number>',
  )
  process.exit(1)
}

if (!env.ROSTER_HASH_SECRET) {
  console.error('ROSTER_HASH_SECRET is not set in server/.env.')
  console.error('Generate one with:')
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  process.exit(1)
}

async function resolveOrganization() {
  const { rows } = args['org-id']
    ? await query('select id, name from public.organizations where id = $1 and is_active', [
        args['org-id'],
      ])
    : await query(
        `select id, name from public.organizations
          where registry_id = public.normalize_registry_id($1) and is_active`,
        [args.registry],
      )

  if (!rows.length) {
    throw new Error(
      `No active organisation matching ${args['org-id'] ?? args.registry}.\n` +
        'List them with:\n' +
        '  node -e "import(\'./db/pool.js\').then(async({query,pool})=>{' +
        'const{rows}=await query(\'select id,name,registry_id from public.organizations\');' +
        'console.table(rows);await pool.end()})"',
    )
  }
  return rows[0]
}

async function main() {
  const org = await resolveOrganization()
  const rows = await readRosterFile(readFileSync(args.file), args.file)
  const { planned, skipped, error } = planRoster(rows, org.id)

  if (error) throw new Error(error)

  console.log(`file          ${args.file}`)
  console.log(`organisation  ${org.name}`)
  console.log(`rows          ${planned.length + skipped.length}  (${planned.length} to import, ${skipped.length} skipped)\n`)

  for (const s of skipped) console.log(`  SKIP  line ${s.line}  ${s.fullName ?? ''}  - ${s.reason}`)

  if (args.dryRun) {
    for (const p of planned) {
      const extra = [p.department, p.jobTitle].filter(Boolean).join(' / ')
      console.log(`  PLAN  ${p.masked}  ${p.fullName ?? ''}${extra ? `  (${extra})` : ''}`)
    }
    console.log('\nDry run - nothing written.')
    return
  }

  const { results, attached } = await withTransaction((client) =>
    applyRoster(planned, (sql, params) => client.query(sql, params)),
  )

  for (const r of results) {
    console.log(`  ${r.status.toUpperCase().padEnd(15)} ${r.masked}  ${r.fullName ?? ''}  ${r.detail}`)
  }

  console.log('\nsummary:', JSON.stringify(tally(results)))
  if (attached) console.log(`attached ${attached} existing account(s) to this organisation`)

  if (args.out) {
    const csv = ['line,full_name,status,detail']
      .concat(
        results
          .concat(skipped.map((s) => ({ line: s.line, fullName: s.fullName, status: 'skipped', detail: s.reason })))
          .map((r) => `${r.line},"${(r.fullName ?? '').replace(/"/g, '""')}",${r.status},"${String(r.detail).replace(/"/g, '""')}"`),
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
