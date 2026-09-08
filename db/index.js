export { pool, query, withTransaction } from './pool.js'
export { supabaseAdmin, supabaseForUser } from './supabase.js'

import { pool } from './pool.js'

/** Cheap round-trip used by the health endpoint. */
export async function checkDatabase() {
  const started = Date.now()
  await pool.query('SELECT 1')
  return { ok: true, latencyMs: Date.now() - started }
}
