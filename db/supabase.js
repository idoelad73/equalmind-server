import { createClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'

/**
 * Service-role client: bypasses row-level security. Server-side only.
 * Never expose this key or its responses' privileges to the browser.
 */
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

/**
 * Build a client scoped to one end user's access token, so row-level security
 * applies as it would in the browser. Use this for anything acting on behalf
 * of a signed-in user.
 */
export function supabaseForUser(accessToken) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
