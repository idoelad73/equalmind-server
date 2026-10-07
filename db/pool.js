import pg from 'pg'
import { env } from '../config/env.js'

/**
 * Direct SQL access to the Supabase Postgres instance.
 * Use this for joins, aggregation and transactions; use the Supabase client
 * (db/supabase.js) for auth and storage.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Supabase's pooler presents a certificate this pool has no root for; the
  // connection is still encrypted. Required in every environment.
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

pool.on('error', (error) => {
  console.error('[db] idle client error:', error.message)
})

/**
 * Which Supabase project this pool is pointed at.
 *
 * Read from SUPABASE_URL rather than DATABASE_URL on purpose: the latter
 * carries the database password, and a boot log is exactly the place it
 * would end up pasted into a ticket.
 */
export function supabaseProjectRef() {
  return new URL(env.SUPABASE_URL).hostname.split('.')[0]
}

/**
 * Prove the pool can actually reach Postgres, and report what it reached.
 *
 * Worth the round trip at boot. `pg` connects lazily, so without this the
 * server reports itself healthy and only fails on the first request - and a
 * startup line claiming a connection that was never made is worse than no
 * line at all, because it is the message you would trust while debugging the
 * case where the connection is the thing that is broken.
 */
export async function verifyConnection() {
  const { rows } = await pool.query('select current_database() as database')
  return { database: rows[0].database, project: supabaseProjectRef() }
}

/** Run a parameterised query. Never interpolate user input into SQL text. */
export function query(text, params) {
  return pool.query(text, params)
}

/** Run several statements in one transaction, rolling back on any failure. */
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
