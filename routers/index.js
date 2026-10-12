import { Router } from 'express'
import { behaviorsRouter } from './behaviors.routes.js'
import { healthRouter } from './health.routes.js'
import { mediaRouter } from './media.routes.js'
import { messagesRouter } from './messages.routes.js'
import { orgRouter } from './org.routes.js'
import { registryRouter } from './registry.routes.js'
import { reportsRouter } from './reports.routes.js'
import { smsRouter } from './sms.routes.js'

export const apiRouter = Router()

apiRouter.use('/behaviors', behaviorsRouter)
apiRouter.use('/health', healthRouter)
apiRouter.use('/media', mediaRouter)
apiRouter.use('/messages', messagesRouter)
apiRouter.use('/org', orgRouter)
apiRouter.use('/registry', registryRouter)
apiRouter.use('/reports', reportsRouter)
// Public: the opt-out link in an invitation SMS. No auth - its
// audience has no account.
apiRouter.use('/sms', smsRouter)
