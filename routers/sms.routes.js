import { Router } from 'express'
import { validate } from '../middlewares/validate.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import { optOutSchema, postOptOut } from '../controllers/optout.controller.js'

export const smsRouter = Router()

// Public and unauthenticated: the people it serves have no account. Rate
// limited because it is public and writes - 20 a minute is generous for a
// human tapping a link and useless for walking the token space, which is
// 128 bits wide anyway.
smsRouter.post(
  '/opt-out',
  rateLimit({ windowMs: 60_000, max: 20 }),
  validate({ body: optOutSchema }),
  postOptOut,
)
