import { Router } from 'express'
import { validate } from '../middlewares/validate.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import { requireAuth } from '../middlewares/requireAuth.js'
import { orgRequestSchema, postActivate, postOrgRequest } from '../controllers/org.controller.js'

export const orgRouter = Router()

// Public, so it is rate limited: 5 submissions per IP per 10 minutes.
orgRouter.post(
  '/requests',
  rateLimit({ windowMs: 10 * 60_000, max: 5 }),
  validate({ body: orgRequestSchema }),
  postOrgRequest,
)

orgRouter.post('/activate', requireAuth, postActivate)
