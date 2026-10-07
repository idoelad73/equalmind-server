import { app } from './app.js'
import { env } from './config/env.js'
import { pool, verifyConnection } from './db/pool.js'

const server = app.listen(env.PORT, async () => {
  console.log(`[equalmind] API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)

  // Which mail driver is live is invisible otherwise: a missing setting
  // falls back to 'supabase', which still "works" - it just sends the
  // English dashboard template instead of our own email.
  const smtpReady = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM)
  console.log(
    `[equalmind] mail: ${env.MAIL_PROVIDER}` +
      (env.MAIL_PROVIDER === 'smtp'
        ? smtpReady
          ? ` via ${env.SMTP_HOST}:${env.SMTP_PORT} as ${env.SMTP_USER}`
          : ' - INCOMPLETE: set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM in server/.env'
        : ' (Supabase template; set MAIL_PROVIDER=smtp in server/.env for the Hebrew email)'),
  )

  // Reported, not fatal. A database that is briefly unreachable at boot
  // should not stop the server coming up - it will recover on its own, and
  // /api/health is what says whether it has.
  try {
    const { database, project } = await verifyConnection()
    console.log(`[equalmind] connected to Supabase equalmind DB (project ${project}, db ${database})`)
  } catch (error) {
    console.error(`[equalmind] NOT connected to the database: ${error.message}`)
    console.error('[equalmind] check DATABASE_URL in server/.env — session pooler, port 5432.')
  }
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
