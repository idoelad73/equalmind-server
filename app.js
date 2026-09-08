import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'

import { env } from './config/env.js'
import { apiRouter } from './routers/index.js'
import { requestId } from './middlewares/requestId.js'
import { notFound } from './middlewares/notFound.js'
import { errorHandler } from './middlewares/errorHandler.js'

export const app = express()

// Render terminates TLS at its proxy; trust it so req.ip and secure cookies work.
app.set('trust proxy', 1)
app.disable('x-powered-by')

// ---- core middleware ----
app.use(requestId)
app.use(helmet())
app.use(
  cors({
    origin: env.clientOrigins,
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(morgan(env.isProduction ? 'combined' : 'dev'))

// ---- routes ----
app.use('/api', apiRouter)

// ---- errors (must stay last, in this order) ----
app.use(notFound)
app.use(errorHandler)
