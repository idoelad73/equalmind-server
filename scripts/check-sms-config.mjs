/**
 * Show exactly what the SMS gateway is being told, and what it answers.
 *
 *   node scripts/check-sms-config.mjs
 *   node scripts/check-sms-config.mjs --send-to 0502271984
 *
 * Gateway errors are terse - "Incorrect key, username or password" does not
 * say which of the three - so this prints the payload as the gateway sees it,
 * with the secrets masked, next to the answer it gives back. Reading those
 * two together is faster than changing one value at a time.
 *
 * Without --send-to it makes no call at all: it only reports configuration.
 */
import 'dotenv/config'
import { env } from '../config/env.js'
import { normalizePhone } from '../lib/phone.js'
import { activeProvider, segmentsFor } from '../lib/smsProvider.js'

const args = process.argv.slice(2)
const sendToIndex = args.indexOf('--send-to')
const sendTo = sendToIndex >= 0 ? args[sendToIndex + 1] : null

/** Enough to recognise a value, not enough to leak it. */
function mask(value, keep = 3) {
  if (!value) return '(not set)'
  if (value.length <= keep * 2) return `${value.slice(0, 1)}***  (${value.length} chars)`
  return `${value.slice(0, keep)}***${value.slice(-keep)}  (${value.length} chars)`
}

console.log('--- configuration -------------------------------------------')
console.log(`SMS_PROVIDER        ${activeProvider()}`)
console.log(`SMS_SENDER          ${env.SMS_SENDER || '(not set)'}`)
console.log(`SMS_INVITE_URL      ${env.SMS_INVITE_URL}`)
console.log(`SMS4FREE_USER       ${env.SMS4FREE_USER || '(not set)'}`)
console.log(`SMS4FREE_PASSWORD   ${mask(env.SMS4FREE_PASSWORD)}`)
console.log(`SMS4FREE_KEY        ${mask(env.SMS4FREE_KEY, 4)}`)

console.log('\n--- what SMS4Free expects -----------------------------------')
console.log('user    the MOBILE NUMBER you registered with, e.g. 0502271984')
console.log('pass    that account\'s password')
console.log('key     the API key from the account page (not the password)')
console.log('sender  on the free 10 messages, the SAME registered number.')
console.log('        A name like "Equalmind" needs a purchased package, and')
console.log('        in Israel also carrier pre-registration.')

const problems = []
if (env.SMS_PROVIDER !== 'sms4free') {
  problems.push(`SMS_PROVIDER is "${env.SMS_PROVIDER}" - nothing will be sent to a real phone.`)
}
if (!env.SMS4FREE_USER) problems.push('SMS4FREE_USER is empty.')
else if (!normalizePhone(env.SMS4FREE_USER)) {
  problems.push(`SMS4FREE_USER is "${env.SMS4FREE_USER}", which is not an Israeli mobile number. It should be the number you registered with.`)
}
if (!env.SMS4FREE_PASSWORD) problems.push('SMS4FREE_PASSWORD is empty.')
if (!env.SMS4FREE_KEY) problems.push('SMS4FREE_KEY is empty.')
if (env.SMS_SENDER && !normalizePhone(env.SMS_SENDER)) {
  problems.push(
    `SMS_SENDER is "${env.SMS_SENDER}", an alphanumeric sender. On the free tier this is rejected with -2; set it to your registered number.`,
  )
}
if (
  env.SMS_SENDER && env.SMS4FREE_USER &&
  normalizePhone(env.SMS_SENDER) && normalizePhone(env.SMS4FREE_USER) &&
  normalizePhone(env.SMS_SENDER) !== normalizePhone(env.SMS4FREE_USER)
) {
  problems.push('SMS_SENDER and SMS4FREE_USER are different numbers. On the free tier they must match.')
}

console.log('\n--- findings ------------------------------------------------')
if (problems.length) for (const p of problems) console.log(`  ✗ ${p}`)
else console.log('  Nothing obviously wrong with the configuration.')

if (!sendTo) {
  console.log('\nNo call made. Re-run with --send-to <number> to try the gateway.')
  process.exit(problems.length ? 1 : 0)
}

/* ------------------------------------------------------------ live call */

const recipient = normalizePhone(sendTo)
if (!recipient) {
  console.error(`\n"${sendTo}" is not a usable Israeli mobile number.`)
  process.exit(1)
}

const body = 'בדיקת חיבור Equalmind'
const local = recipient.replace(/^\+972/, '0')

console.log('\n--- request -------------------------------------------------')
console.log('POST https://api.sms4free.co.il/ApiSMS/v2/SendSMS')
console.log(JSON.stringify({
  key: mask(env.SMS4FREE_KEY, 4),
  user: env.SMS4FREE_USER,
  pass: mask(env.SMS4FREE_PASSWORD),
  sender: env.SMS_SENDER,
  recipient: local,
  msg: body,
}, null, 2))
console.log(`\n(${segmentsFor(body).segments} segment)`)

const response = await fetch('https://api.sms4free.co.il/ApiSMS/v2/SendSMS', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    key: env.SMS4FREE_KEY,
    user: env.SMS4FREE_USER,
    pass: env.SMS4FREE_PASSWORD,
    sender: env.SMS_SENDER,
    recipient: local,
    msg: body,
  }),
})

const text = await response.text()
console.log('\n--- response ------------------------------------------------')
console.log(`HTTP ${response.status}`)
console.log(text)

let status = Number(text)
try {
  const parsed = JSON.parse(text)
  status = Number(parsed.status ?? status)
} catch {
  // bare number
}

const MEANING = {
  '-1': 'key, user or pass is wrong. user must be your registered MOBILE NUMBER, and key is the API key, not the password.',
  '-2': 'sender rejected. On the free tier, sender must be the registered number.',
  '-3': 'no remaining messages on the account.',
  '-4': 'blocked or inactive account.',
  '-5': 'the message body is empty or invalid.',
  '-6': 'no valid recipients.',
}

console.log('\n--- meaning -------------------------------------------------')
if (Number.isFinite(status) && status > 0) {
  console.log(`  Sent to ${status} recipient(s). Check the handset.`)
} else if (MEANING[String(status)]) {
  console.log(`  ${status}: ${MEANING[String(status)]}`)
} else {
  console.log(`  Unrecognised response. Their support line is 072-256-9090.`)
}
