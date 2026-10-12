/**
 * Opting out of invitation SMS.
 *
 * A LINK rather than a reply. SMS4Free's free tier has no inbound channel,
 * so 'השיבו "הסר"' cannot be honoured however carefully it is worded -
 * and an opt-out that is offered but not honoured is the violation, not
 * the remedy (Communications Law s.30A: up to NIS 1,000 per message, no
 * proof of damage required).
 *
 * The link carries a random token and nothing else. Never the phone
 * number, never its hash: a URL ends up in logs, browser history, link
 * previews and screenshots, and none of those are places for a way back
 * to a person who never signed up for anything.
 *
 * The suppression list is keyed by the same HMAC the roster uses, so it is
 * not a second list of real numbers, and it OUTLIVES the roster row. A
 * list that a re-import clears is not a suppression list.
 */
import { query } from '../db/pool.js'
import { env } from '../config/env.js'
import { hashPhone } from './rosterHash.js'

const OPT_OUT_PATH = '/u'

/**
 * Derived from CLIENT_ORIGIN rather than given its own variable.
 *
 * One fewer thing to leave pointing at a laptop: SMS_INVITE_URL spent a
 * week as a LAN address that reached nobody, and a second copy of the same
 * hostname is a second chance to make that mistake.
 */
export function optOutUrlFor(token) {
  return `${env.clientOrigins[0]}${OPT_OUT_PATH}/${token}`
}

/**
 * A token of exactly the real length, for the preview.
 *
 * The segment count has to be the real one before anybody presses send.
 * Previewing with a short placeholder would under-report by a whole
 * segment per recipient - the same bug the {url} counter had.
 */
export const SAMPLE_OPT_OUT_TOKEN = 'x'.repeat(22)

/** Which of these numbers have asked to stop. Returns a Set of hashes. */
export async function optedOutHashes(phones) {
  const hashes = phones.map(hashPhone).filter(Boolean)
  if (!hashes.length) return new Set()

  const { rows } = await query(
    'select phone_hash from public.sms_opt_outs where phone_hash = any($1)',
    [hashes],
  )
  return new Set(rows.map((r) => r.phone_hash))
}

/**
 * Record an opt-out from a token.
 *
 * Idempotent: someone who taps the link twice, or whose SMS app fetched it
 * once on their behalf, must not see a failure. Returns null when the
 * token matches nothing, which the caller reports the same way as success
 * - an unknown token is not a reason to tell a stranger whether some other
 * token exists.
 */
export async function optOutByToken(token) {
  const { rows } = await query(
    `select r.phone_hash, r.organization_id, o.name as organization
       from public.org_rosters r
       left join public.organizations o on o.id = r.organization_id
      where r.opt_out_token = $1`,
    [token],
  )
  if (!rows.length) return null

  await query(
    `insert into public.sms_opt_outs (phone_hash, source, organization_id)
     values ($1, 'link', $2)
     on conflict (phone_hash) do nothing`,
    [rows[0].phone_hash, rows[0].organization_id],
  )

  return { organization: rows[0].organization }
}
