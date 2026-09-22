import { AppError } from './AppError.js'
import { env } from '../config/env.js'
import { normalizePhone } from './phone.js'

/**
 * The one place the rest of the server sends SMS.
 *
 * Controllers never talk to a gateway directly. Israel is an expensive
 * destination and the market is unsettled - international gateways charge
 * around $0.26 a segment where local Israeli providers are a fraction of
 * that - so the vendor will change. When it does, that is a new driver in
 * `DRIVERS` below and nothing else.
 *
 * Nothing here writes to the database. The caller records the result in
 * sms_outbox, the same way mediaProvider leaves persistence to its caller.
 *
 * TWO THINGS EVERY DRIVER MUST GET RIGHT
 *
 * 1. Hebrew is UCS-2, so a segment is 70 characters, not 160. A message
 *    that looks short in English silently becomes three segments in Hebrew
 *    and costs three times what was budgeted. `segmentsFor` is exported so
 *    callers can see the real cost before sending.
 *
 * 2. A number is only ever passed in E.164. Drivers do not re-parse or
 *    re-format; `lib/phone.js` is the only normaliser in the codebase.
 */

/** Hebrew forces UCS-2 encoding, which halves the segment size. */
const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|€]*$/

export function segmentsFor(body) {
  const unicode = !GSM7.test(body)
  const limit = unicode ? 70 : 160
  const multipart = unicode ? 67 : 153
  if (body.length <= limit) return { segments: 1, unicode, limit }
  return { segments: Math.ceil(body.length / multipart), unicode, limit: multipart }
}

/* ----------------------------------------------------------- the drivers */

/**
 * Sends nothing. Records everything.
 *
 * The default, deliberately: a misconfigured environment should fail to
 * reach anybody rather than quietly message a real roster. A driver is
 * opted into by setting SMS_PROVIDER, never inferred from credentials
 * happening to be present.
 */
const mock = {
  name: 'mock',
  configured: () => true,
  async send({ to, body }) {
    const { segments, unicode } = segmentsFor(body)
    console.log(
      `[sms:mock] -> ${to}  ${segments} segment(s)${unicode ? ', unicode' : ''}\n` +
        body.split('\n').map((l) => `           | ${l}`).join('\n'),
    )
    return { ref: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  },
}

/**
 * SMS4Free - an Israeli gateway, chosen for the demo because registration
 * gives ten free messages with no card and the message arrives from a normal
 * Israeli number rather than a foreign one.
 *
 * Not wired to credentials yet. Filling in SMS4FREE_* and setting
 * SMS_PROVIDER=sms4free is all that should be needed.
 */
const sms4free = {
  name: 'sms4free',
  configured: () =>
    Boolean(env.SMS4FREE_KEY && env.SMS4FREE_USER && env.SMS4FREE_PASSWORD),
  async send({ to, body }) {
    const response = await fetch('https://api.sms4free.co.il/ApiSMS/v2/SendSMS', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: env.SMS4FREE_KEY,
        user: env.SMS4FREE_USER,
        pass: env.SMS4FREE_PASSWORD,
        sender: env.SMS_SENDER,
        // The gateway expects local Israeli format, not E.164.
        recipient: to.replace(/^\+972/, '0'),
        msg: body,
      }),
    })

    return parseSms4freeResponse(response.ok, await response.text())
  },
}

/**
 * Read an SMS4Free response.
 *
 * The gateway answers in two shapes - a bare number, and a JSON object with
 * `status` and `message` - and both mean the same thing: positive is the
 * number of messages sent, zero or negative is an error code.
 *
 * Exported so the two shapes can be tested without spending a message. This
 * is worth the seam: the first version only understood the bare number, so a
 * JSON `{"status":1,"message":"Succeeded"}` was read as a failure. The
 * message had already been delivered, and a retry would have sent it twice.
 */
export function parseSms4freeResponse(httpOk, text) {
  let status
  let message

  try {
    const parsed = JSON.parse(text)
    // JSON.parse("3") succeeds and returns the number 3, so "is it JSON" is
    // not the question - "is it an object" is. Reading .status off a number
    // yields undefined, which is how a bare success was read as a failure.
    if (parsed && typeof parsed === 'object') {
      status = Number(parsed.status)
      message = String(parsed.message ?? '').trim()
    } else {
      status = Number(parsed)
      message = String(text).trim()
    }
  } catch {
    status = Number(text)
    message = String(text).trim()
  }

  if (httpOk && Number.isFinite(status) && status > 0) {
    return { ref: `sms4free-${status}` }
  }

  // -2 is the most common first failure, and the gateway's own wording
  // ("Massage sender name or number is incorrect") does not say why. On the
  // free tier the sender must be the number the account was registered with;
  // an alphanumeric sender needs a paid package and, in Israel, carrier
  // pre-registration.
  if (status === -2) {
    throw new AppError(
      502,
      'sms_sender_rejected',
      `הספק דחה את שם השולח "${env.SMS_SENDER}". בחבילה החינמית יש לשלוח ` +
        'ממספר הטלפון שאיתו נרשמתם - יש להגדיר SMS_SENDER למספר הזה.',
    )
  }

  throw new AppError(
    502,
    'sms_failed',
    `שליחת ההודעה נכשלה (${Number.isFinite(status) ? status : '?'}: ${message || 'ללא פירוט'}).`,
  )
}

const DRIVERS = { mock, sms4free }

function driver() {
  const chosen = DRIVERS[env.SMS_PROVIDER]
  if (!chosen) {
    throw new AppError(
      500,
      'sms_provider_unknown',
      `ספק SMS לא מוכר: ${env.SMS_PROVIDER}.`,
    )
  }
  if (!chosen.configured()) {
    throw new AppError(
      500,
      'sms_provider_unconfigured',
      `ספק ה-SMS (${chosen.name}) אינו מוגדר במלואו.`,
    )
  }
  return chosen
}

/**
 * Numbers allowed to actually receive, while the allowlist is set.
 *
 * Enforced here rather than at each call site, because a guard that has to
 * be remembered is a guard that will be forgotten exactly once - and once is
 * an entire company's staff receiving a message they never agreed to.
 */
function allowlist() {
  return env.SMS_ALLOWLIST.split(',')
    .map((v) => normalizePhone(v.trim()))
    .filter(Boolean)
}

/** Whether the allowlist is restricting sends right now. */
export function allowlistActive() {
  return allowlist().length > 0
}

export function allowedNumbers() {
  return allowlist()
}

/** Which driver is active, for a caller that wants to say so in the UI. */
export const activeProvider = () => env.SMS_PROVIDER

/** True when nothing actually leaves the server. */
export const isDryProvider = () => env.SMS_PROVIDER === 'mock'

/**
 * Send one message.
 *
 * Returns `{ provider, ref }` on success and throws AppError otherwise, so
 * a caller recording to sms_outbox has both outcomes in a usable shape.
 */
export async function sendSms({ to, body }) {
  const e164 = normalizePhone(to)
  if (!e164) throw AppError.badRequest('מספר הנייד אינו תקין.')
  if (!body?.trim()) throw AppError.badRequest('גוף ההודעה ריק.')

  const active = driver()

  const allowed = allowlist()
  if (allowed.length && !allowed.includes(e164)) {
    // Not an error: the caller asked for something reasonable and the
    // environment declined. Recorded as skipped so the run still shows
    // who would have been messaged.
    return { provider: active.name, ref: null, skipped: true, reason: 'not in SMS_ALLOWLIST' }
  }

  const { ref } = await active.send({ to: e164, body })
  return { provider: active.name, ref, skipped: false }
}

/**
 * Fill {org} and {url} in a template.
 *
 * An unknown placeholder becomes empty rather than being left as literal
 * braces: a stray {nmae} should read as a typo, not be delivered as one.
 */
export function renderTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')
}

/* ---------------------------------------------------------- the messages */

/**
 * Message bodies live here rather than at the call site, because their
 * length is a cost: see segmentsFor. Keeping them together makes it
 * possible to see, in one place, what is being paid for per send.
 *
 * Deliberately plain. The more this reads like marketing, the more clearly
 * it is a דבר פרסומת under Israel's Anti-Spam Law, which needs prior
 * written consent and carries statutory damages of up to NIS 1,000 per
 * message. Stating a fact and giving a link is the safer shape - and the
 * consent question is still the organisation's to answer before any real
 * roster is messaged.
 */
/**
 * Used when an organisation has set no template of its own. Kept here, not
 * in the database, so a new organisation is never without a message.
 */
export const DEFAULT_INVITE_TEMPLATE =
  '{org} הצטרף ל-Equalmind.\nלהרשמה: {url}\nלהסרה השיבו "הסר".'

export const MESSAGES = {
  /** `template` is organizations.invite_sms_template, or null for the default. */
  rosterInvite: ({ organizationName, url, template }) =>
    renderTemplate(template || DEFAULT_INVITE_TEMPLATE, { org: organizationName, url }),
}
