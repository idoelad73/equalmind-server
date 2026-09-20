/**
 * Israeli phone numbers, normalised to E.164.
 *
 * This is the single place a number becomes canonical. The roster hashes
 * whatever this returns, and a claim hashes whatever this returns, so the two
 * only ever match if both went through here. A second normaliser anywhere
 * else in the codebase would silently halve the match rate.
 *
 *   050-123-4567   ->  +972501234567
 *   0501234567     ->  +972501234567
 *   501234567      ->  +972501234567
 *   +972-50-1234567->  +972501234567
 *   972501234567   ->  +972501234567
 */

/** Israeli mobile prefixes, without the leading zero. */
const MOBILE = /^5[0-9]\d{7}$/

/**
 * Returns E.164, or null if this is not a usable Israeli mobile number.
 *
 * Mobiles only, deliberately: the roster exists to reach a person, and the
 * number will carry SMS later. A landline would match a human being to an
 * organisation just as well, but it cannot receive anything.
 */
export function normalizePhone(input) {
  if (input === null || input === undefined) return null

  let digits = String(input).replace(/\D/g, '')
  if (!digits) return null

  // Strip the country code in whichever form it arrived.
  if (digits.startsWith('00972')) digits = digits.slice(5)
  else if (digits.startsWith('972')) digits = digits.slice(3)

  // Strip the trunk prefix. Done after the country code, since "0972..."
  // is a local number, not a mangled international one.
  if (digits.startsWith('0')) digits = digits.slice(1)

  return MOBILE.test(digits) ? `+972${digits}` : null
}

/** True when the value is a phone number we can actually use. */
export const isPhone = (value) => normalizePhone(value) !== null

/**
 * For display: +972501234567 -> 050-1234567. Never for comparison - compare
 * the E.164 form, or the hash of it.
 */
export function formatPhone(e164) {
  const m = /^\+972(\d{2})(\d{7})$/.exec(e164 ?? '')
  return m ? `0${m[1]}-${m[2]}` : (e164 ?? '')
}
