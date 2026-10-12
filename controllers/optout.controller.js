import { z } from 'zod'
import { optOutByToken } from '../lib/optOut.js'

/**
 * The public end of the opt-out link.
 *
 * NO AUTHENTICATION, deliberately: the people this serves have no account
 * and never agreed to anything. Requiring one would make the opt-out
 * unusable by exactly the audience it exists for.
 *
 * The token is the whole credential, which is why it is random and why it
 * is the only thing the link carries.
 */

// 22 characters of URL-safe base64 - see migration 030. Validated for
// shape so a malformed token is a 400 rather than a database round trip
// per request from whatever is scanning the endpoint.
export const optOutSchema = z.object({
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{16,64}$/, 'קישור לא תקין'),
})

/**
 * Record the opt-out.
 *
 * ALWAYS ANSWERS THE SAME WAY. An unknown token gets the same 200 as a
 * real one: anything else turns this endpoint into an oracle for guessing
 * which tokens exist, and the person reading the page cannot act on the
 * difference anyway.
 *
 * It is a POST rather than a GET even though it arrives from a link,
 * because SMS apps, messaging clients and security scanners fetch links
 * to build previews. A GET that unsubscribes would opt people out who
 * only received the message. The link opens a page; the page asks.
 */
export async function postOptOut(req, res) {
  const result = await optOutByToken(req.body.token)

  res.json({
    ok: true,
    // Present only when the token matched. The page greets someone by
    // their employer's name when it can, and says nothing when it cannot.
    organization: result?.organization ?? null,
  })
}
