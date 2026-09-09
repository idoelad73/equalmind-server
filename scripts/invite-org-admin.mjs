/**
 * Invite an organisation admin.
 *
 * There is no HTTP endpoint for this on purpose. Granting org_admin is the
 * most sensitive action in the system - that account sees the reports about
 * an organisation - so it stays a deliberate, service-role-only operation
 * with no public surface to attack.
 *
 *   node scripts/invite-org-admin.mjs \
 *     --org "שם הארגון" --email admin@company.co.il \
 *     [--industry "טכנולוגיה"] [--company-number 512345678] \
 *     [--employees 120] [--name "עידו אלעד"] [--mobile 0501234567] \
 *     [--org-id <uuid>]   reuse an existing organisation instead of creating
 *     [--dry-run]         show what would happen, change nothing
 *
 * Order matters: inviteUserByEmail creates the auth user, which fires the
 * signup trigger and produces a regular profile. Only then do we promote it.
 */
import 'dotenv/config'
import { supabaseAdmin } from '../db/supabase.js'
import { query, pool } from '../db/pool.js'
import { env } from '../config/env.js'

function parseArgs(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') { out.dryRun = true; continue }
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) continue
    out[key] = value
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const email = args.email?.trim().toLowerCase()
const orgName = args.org?.trim()

if (!email || (!orgName && !args['org-id'])) {
  console.error(
    'Usage: node scripts/invite-org-admin.mjs --org "<name>" --email <address>\n' +
      '       (or --org-id <uuid> to reuse an existing organisation)',
  )
  process.exit(1)
}

const redirectTo = `${env.clientOrigins[0]}/invite/accept`

async function main() {
  // ---- 1. the organisation -------------------------------------------
  let organization

  if (args['org-id']) {
    const { rows } = await query('select * from public.organizations where id = $1', [
      args['org-id'],
    ])
    if (!rows.length) throw new Error(`No organisation with id ${args['org-id']}`)
    organization = rows[0]
  } else {
    const { rows: existing } = await query(
      'select * from public.organizations where lower(name) = lower($1)',
      [orgName],
    )
    if (existing.length) {
      organization = existing[0]
      console.log(`organisation exists          ${organization.name} (${organization.id})`)
    } else if (args.dryRun) {
      console.log(`would create organisation    ${orgName}`)
      organization = { id: '<new>', name: orgName }
    } else {
      const { rows } = await query(
        `insert into public.organizations
           (name, industry, company_number, employee_count)
         values ($1, $2, $3, $4)
         returning *`,
        [
          orgName,
          args.industry ?? null,
          args['company-number'] ?? null,
          args.employees ? Number(args.employees) : null,
        ],
      )
      organization = rows[0]
      console.log(`organisation created         ${organization.name} (${organization.id})`)
    }
  }

  // ---- 2. refuse to invite someone who already administers an org -----
  const { rows: clash } = await query(
    `select a.user_id, o.name
       from public.org_admins a
       join public.organizations o on o.id = a.organization_id
       join auth.users u on u.id = a.user_id
      where lower(u.email) = $1`,
    [email],
  )
  if (clash.length) {
    throw new Error(`${email} already administers "${clash[0].name}"`)
  }

  if (args.dryRun) {
    console.log(`would invite                 ${email}`)
    console.log(`would grant org_admin on     ${organization.name}`)
    console.log(`invite would return to       ${redirectTo}`)
    return
  }

  // ---- 3. invite (creates the auth user and sends the email) ----------
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { organization_name: organization.name },
  })

  if (error) {
    // An existing account cannot be re-invited; link it instead.
    if (/already been registered|already exists/i.test(error.message)) {
      throw new Error(
        `${email} already has an account. Link it with --existing once that flow exists, ` +
          'or delete the account first.',
      )
    }
    throw error
  }

  const userId = data.user.id
  console.log(`invited                      ${email}`)
  console.log(`auth user                    ${userId}`)

  // ---- 4. grant, with the service role, using the returned id ---------
  await query(
    `insert into public.org_admins
       (user_id, organization_id, full_name, mobile, contact_email)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set organization_id = excluded.organization_id,
           updated_at = now()`,
    [userId, organization.id, args.name ?? null, args.mobile ?? null, email],
  )

  await query(`update public.profiles set user_type = 'org_admin' where id = $1`, [userId])

  console.log(`granted org_admin on         ${organization.name}`)
  console.log(`\nThey now have an invite email. It returns them to ${redirectTo}`)
  console.log('where they set a password. Until then the account cannot be used.')
}

main()
  .catch((error) => {
    console.error('\nFAILED:', error.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())
