/**
 * Create the organisations for admins who completed onboarding but were
 * never activated.
 *
 *   node scripts/activate-org-admins.mjs [--dry-run]
 *
 * Onboarding writes org_admin_details and then calls POST /api/org/activate,
 * which is what turns the declared details into a real organizations row and
 * an org_admins membership. An admin who onboarded before that endpoint did
 * the creating - or while it was failing - ends up holding the role with
 * nothing to administer: no organisation, no dashboard, no join code, and no
 * target for a roster import.
 *
 * This finds them and finishes the job. It is the same logic as
 * controllers/org.controller.js postActivate, applied in bulk, and it is
 * safe to re-run: an admin who already has a membership is skipped.
 */
import 'dotenv/config'
import { query, withTransaction, pool } from '../db/pool.js'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  const { rows: pending } = await query(
    `select d.user_id, d.org_name, d.registry_id, d.registry_source,
            d.industry, d.org_address, d.employee_count,
            p.email
       from public.org_admin_details d
       join public.profiles p on p.id = d.user_id and p.user_type = 'org_admin'
       left join public.org_admins a on a.user_id = d.user_id
      where a.user_id is null
      order by d.created_at`,
  )

  console.log(`pending admins   ${pending.length}\n`)
  if (!pending.length) {
    console.log('Nothing to do - every onboarded admin already has an organisation.')
    return
  }

  for (const admin of pending) {
    const { rows: existing } = await query(
      `select id, name from public.organizations
        where (registry_id is not null
               and registry_id = public.normalize_registry_id($1))
           or lower(name) = lower($2)
        order by (registry_id is not null
                  and registry_id = public.normalize_registry_id($1)) desc
        limit 1`,
      [admin.registry_id, admin.org_name],
    )

    const verb = existing.length ? 'reuse organisation ' : 'create organisation'

    if (dryRun) {
      console.log(`  PLAN  ${admin.email}`)
      console.log(`        ${verb}  ${admin.org_name}  (${admin.registry_id ?? 'no registry number'})`)
      continue
    }

    const organizationId = await withTransaction(async (client) => {
      let id = existing[0]?.id

      if (!id) {
        const { rows: created } = await client.query(
          `insert into public.organizations
             (name, registry_id, registry_source, industry, address, employee_count)
           values ($1,$2,$3,$4,$5,$6)
           returning id`,
          [
            admin.org_name,
            admin.registry_id,
            admin.registry_source,
            admin.industry,
            admin.org_address,
            admin.employee_count,
          ],
        )
        id = created[0].id
      }

      await client.query(
        `insert into public.org_admins (user_id, organization_id, contact_email, activated_at)
         values ($1, $2, $3, now())
         on conflict (user_id) do update
            set organization_id = excluded.organization_id,
                activated_at = coalesce(public.org_admins.activated_at, now()),
                updated_at = now()`,
        [admin.user_id, id, admin.email],
      )

      await client.query(
        `update public.org_admin_details set organization_id = $2 where user_id = $1`,
        [admin.user_id, id],
      )

      return id
    })

    console.log(`  DONE  ${admin.email}`)
    console.log(`        ${verb}  ${admin.org_name}`)
    console.log(`        organization_id  ${organizationId}`)
  }

  if (dryRun) console.log('\nDry run - nothing written.')
}

main()
  .catch((error) => {
    console.error('\nFAILED:', error.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())
