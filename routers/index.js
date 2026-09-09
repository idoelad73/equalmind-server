import { Router } from 'express'
import { healthRouter } from './health.routes.js'
import { mediaRouter } from './media.routes.js'
import { orgRouter } from './org.routes.js'
import { registryRouter } from './registry.routes.js'

export const apiRouter = Router()

apiRouter.use('/health', healthRouter)
apiRouter.use('/media', mediaRouter)
apiRouter.use('/org', orgRouter)
apiRouter.use('/registry', registryRouter)

// Feature routers mount here as they are built:
// apiRouter.use('/reports', reportsRouter)
