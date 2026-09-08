import { checkDatabase } from '../db/index.js'

/** Liveness + database reachability. Used by the client and by Render. */
export async function getHealth(_req, res) {
  let db = 'unreachable'
  let latencyMs = null

  try {
    const result = await checkDatabase()
    db = 'ok'
    latencyMs = result.latencyMs
  } catch (error) {
    console.error('[health] database check failed:', error.message)
  }

  res.status(db === 'ok' ? 200 : 503).json({
    status: 'ok',
    db,
    latencyMs,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  })
}
