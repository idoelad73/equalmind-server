import { app } from './app.js'
import { env } from './config/env.js'
import { pool } from './db/pool.js'

const server = app.listen(env.PORT, () => {
  console.log(`[equalmind] API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
})

/** Finish in-flight requests and close the pool before exiting. */
function shutdown(signal) {
  console.log(`[equalmind] ${signal} received, shutting down…`)
  server.close(async () => {
    await pool.end().catch(() => {})
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
