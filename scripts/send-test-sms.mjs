/**
 * Send one SMS, to one number, on purpose.
 *
 *   node scripts/send-test-sms.mjs --name "עידו אלעד"
 *   node scripts/send-test-sms.mjs --name "עידו אלעד" --send
 *   node scripts/send-test-sms.mjs --to 050-227-1984 --send
 *   node scripts/send-test-sms.mjs --to 0502271984 --message "בדיקה" --send
 *
 * For proving the pipeline to a real handset before a roster is ever
 * messaged in bulk. One recipient, named explicitly, every time.
 *
 * PREVIEW IS THE DEFAULT. Without --send it prints exactly what would go
 * out - body, segment count, destination - and sends nothing. There is no
 * flag that sends to more than one number; use the notify endpoint for
 * that, where the rate limit and the opt-out rules live.
 *
 * Flags:
 *   --name <text>      pick a roster row by employee name
 *   --roster-id <uuid> pick a roster row by id
 *   --to <phone>       any number, whether or not it is on a roster
 *   --message <text>   override the body (default: the roster invitation)
 *   --send             actually send
 */
import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { query, pool } from '../db/pool.js'
import { env } from '../config/env.js'
import { normalizePhone, formatPhone } from '../lib/phone.js'
import {
  activeProvider,
  isDryProvider,
  MESSAGES,
  segmentsFor,
  sendSms,
} from '../lib/smsProvider.js'

function parseArgs(argv) {
  const out = { send: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--send') { out.send = true; continue }
    if (!arg.startsWith('--')) continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) continue
    out[arg.slice(2)] = value
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (!args.name && !args['roster-id'] && !args.to) {
  console.error(
    'Usage:\n' +
      '  node scripts/send-test-sms.mjs --name "עידו אלעד" [--send]\n' +
      '  node scripts/send-test-sms.mjs --to 0502271984 [--send]',
  )
  process.exit(1)
}

/** The roster row, when one was named. */
async function findTarget() {
  if (args.to) {
    const e164 = normalizePhone(args.to)
    if (!e164) throw new Error(`"${args.to}" is not a usable Israeli mobile number.`)

    // Still look for a roster row, so the message names the right
    // organisation and the send is recorded against it.
    const { rows } = await query(
      `select r.id, r.employee_name, r.phone, r.organization_id,
              o.name as org, o.invite_sms_template as template
         from public.org_rosters r
         join public.organizations o on o.id = r.organization_id
        where r.phone = $1`,
      [e164],
    )
    return (
      rows[0] ?? {
        id: null, employee_name: null, phone: e164,
        organization_id: null, org: null, template: null,
      }
    )
  }

  const { rows } = await query(
    `select r.id, r.employee_name, r.phone, r.organization_id,
            o.name as org, o.invite_sms_template as template
       from public.org_rosters r
       join public.organizations o on o.id = r.organization_id
      where ${args['roster-id'] ? 'r.id = $1' : 'r.employee_name = $1'}`,
    [args['roster-id'] ?? args.name],
  )

  if (!rows.length) throw new Error(`No roster row matching ${args['roster-id'] ?? args.name}.`)
  if (rows.length > 1) throw new Error(`${rows.length} roster rows match that name. Use --roster-id.`)
  if (!rows[0].phone) {
    throw new Error(
      `"${rows[0].employee_name}" has no stored number - only a hash, which cannot be reversed. ` +
        'Re-upload the roster so the number is stored, or pass --to.',
    )
  }
  return rows[0]
}

async function main() {
  const target = await findTarget()

  // The organisation's own template when it has one, so this sends exactly
  // what the dashboard would send. Without passing it, the script would
  // quietly fall back to the built-in default and "test" a message nobody
  // is actually going to receive.
  const body =
    args.message ??
    MESSAGES.rosterInvite({
      organizationName: target.org ?? 'Equalmind',
      url: env.SMS_INVITE_URL,
      template: target.template,
    })

  const cost = segmentsFor(body)

  console.log(`provider     ${activeProvider()}${isDryProvider() ? '  (nothing leaves the server)' : ''}`)
  console.log(`sender       ${env.SMS_SENDER}`)
  console.log(`to           ${formatPhone(target.phone)}   ${target.employee_name ?? '(not on a roster)'}`)
  if (target.org) console.log(`organisation ${target.org}`)
  console.log(`message      ${args.message ? 'override from --message' : target.template ? "the organisation's own" : 'built-in default'}`)
  console.log(`segments     ${cost.segments}${cost.unicode ? '  (unicode - Hebrew is 70 chars per segment)' : ''}`)
  console.log(`\n${body.split('\n').map((l) => '  | ' + l).join('\n')}\n`)

  if (!args.send) {
    console.log('Preview only. Re-run with --send to actually send.')
    return
  }

  if (isDryProvider()) {
    console.log('SMS_PROVIDER is "mock", so --send still reaches nobody.')
    console.log('To send for real: register at https://www.sms4free.co.il, then in server/.env set')
    console.log('  SMS_PROVIDER=sms4free')
    console.log('  SMS4FREE_KEY= / SMS4FREE_USER= / SMS4FREE_PASSWORD=')
    console.log('  SMS_INVITE_URL=<a URL reachable from a phone, not localhost>\n')
  }

  // A real send costs money and reaches a real handset, so it is confirmed
  // out loud rather than assumed from a flag.
  if (!isDryProvider()) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`Send ${cost.segments} segment(s) to ${formatPhone(target.phone)}? [y/N] `)
    rl.close()
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Cancelled. Nothing sent.')
      return
    }
  }

  const { rows: [record] } = await query(
    `insert into public.sms_outbox
       (provider, kind, phone, body, organization_id, roster_id, status)
     values ($1, 'test', $2, $3, $4, $5, 'queued')
     returning id`,
    [activeProvider(), target.phone, body, target.organization_id, target.id],
  )

  try {
    const { provider, ref } = await sendSms({ to: target.phone, body })
    await query(
      `update public.sms_outbox
          set status = 'sent', provider = $2, provider_ref = $3, sent_at = now()
        where id = $1`,
      [record.id, provider, ref],
    )
    console.log(`\nSent via ${provider}.  ref ${ref}`)
    console.log(`Recorded in sms_outbox as ${record.id}`)
  } catch (error) {
    await query(
      `update public.sms_outbox set status = 'failed', error = $2 where id = $1`,
      [record.id, error?.message ?? 'unknown'],
    )
    throw error
  }
}

main()
  .catch((error) => {
    console.error('\nFAILED:', error.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())
