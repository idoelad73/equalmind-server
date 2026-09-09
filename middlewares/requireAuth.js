import { AppError } from '../lib/AppError.js'
import { supabaseAdmin } from '../db/supabase.js'

/**
 * Verifies the Supabase access token the client sends as a Bearer header and
 * attaches the account to `req.user`.
 *
 * The token is validated by Supabase rather than decoded locally: it costs a
 * round trip, but it honours revocation and needs no copy of the project's JWT
 * secret on this server. If that round trip ever shows up in latency, the
 * change is to verify the signature locally with the JWT secret - a swap
 * inside this file, not at the call sites.
 */
export async function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? ''
  const [scheme, token] = header.split(' ')

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return next(AppError.unauthorized())
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data?.user) {
    return next(AppError.unauthorized('ההתחברות פגה. יש להתחבר מחדש.'))
  }

  req.user = { id: data.user.id, email: data.user.email ?? null }
  next()
}
