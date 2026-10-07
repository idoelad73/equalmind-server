import { Router } from 'express'
import { requireAuth } from '../middlewares/requireAuth.js'
import { requireSystemAdmin } from '../middlewares/requireSystemAdmin.js'
import { validate } from '../middlewares/validate.js'
import {
  approveMessage,
  approveSchema,
  decisionSchema,
  denyMessage,
  getUnreadCount,
  listMessages,
  listSchema,
} from '../controllers/messages.controller.js'

export const messagesRouter = Router()

// Staff only, every route. These rows name the reporter.
messagesRouter.use(requireAuth, requireSystemAdmin)

messagesRouter.get('/count', getUnreadCount)
messagesRouter.get('/', validate({ query: listSchema }), listMessages)

// Approval also adds the Hook to public.behaviors - see approveMessage.
messagesRouter.post('/:id/approve', validate({ body: approveSchema }), approveMessage)
messagesRouter.post('/:id/deny', validate({ body: decisionSchema }), denyMessage)
