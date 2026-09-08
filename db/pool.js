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
