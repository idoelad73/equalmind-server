import { Router } from 'express'
import { healthRouter } from './health.routes.js'

export const apiRouter = Router()

apiRouter.use('/health', healthRouter)

// Feature routers mount here as they are built:
// apiRouter.use('/auth', authRouter)
// apiRouter.use('/reports', reportsRouter)
