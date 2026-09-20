import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { AppError } from './AppError.js'
import { normalizePhone } from './phone.js'

/**
 * Turns a phone number into the opaque key the roster is stored under.
 *
 * A roster is a list of people who have not signed up and never agreed to
 * anything, so the number itself is never written down. What is stored is
 * HMAC-SHA256 of the E.164 form under a secret that lives in the server
 * environment - not in the database, not in any backup of it.
 *
 * HMAC rather than a plain hash because the number space is tiny: there are
 * about ten million Israeli mobile numbers, so a bare SHA-256 of one is
 * reversible on a laptop in minutes. The secret is what makes the stored
 * value useless to anyone holding only the database.
 *
 * THE SECRET CANNOT BE ROTATED WITHOUT RE-IMPORTING EVERY ROSTER. There is
 * no plaintext to re-hash from - that is the point - so changing it orphans
 * every unclaimed row. Losing it does the same.
 */
export function hashPhone(input) {
  const e164 = normalizePhone(input)
  if (!e164) return null

  if (!env.ROSTER_HASH_SECRET) {
    throw new AppError(
      500,
      'roster_not_configured',
      'שירות שיוך העובדים אינו מוגדר.',
    )
  }

  return createHmac('sha256', env.ROSTER_HASH_SECRET).update(e164).digest('hex')
}

/** Constant-time compare, for anywhere two hashes are checked directly. */
export function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/* ------------------------------------------------------------- join codes */

// No 0/O/1/I/L: these get read aloud, written on whiteboards and retyped.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** A join code in the shape XXXX-XXXX. */
export function generateJoinCode() {
  let out = ''
  for (let i = 0; i < 8; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    if (i === 3) out += '-'
  }
  return out
}

/**
 * Codes are typed by hand, so accept any casing and any separator, then
 * compare the canonical form.
 */
export function normalizeJoinCode(input) {
  const clean = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : null
}
