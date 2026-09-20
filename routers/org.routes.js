import { Router } from 'express'
import { validate } from '../middlewares/validate.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import { requireAuth } from '../middlewares/requireAuth.js'
import { requireOrgAdmin } from '../middlewares/requireOrgAdmin.js'
import { singleCsv } from '../middlewares/upload.js'
import {
  affiliationSchema,
  claimByPhoneSchema,
  deleteAffiliation,
  deleteRoster,
  getJoinCode,
  getRoster,
  joinByCodeSchema,
  orgRequestSchema,
  postActivate,
  postClaimByPhone,
  postJoinByCode,
  postOrgRequest,
  postRoster,
  postRotateJoinCode,
  putAffiliation,
} from '../controllers/org.controller.js'

export const orgRouter = Router()

// Public, so it is rate limited: 5 submissions per IP per 10 minutes.
orgRouter.post(
  '/requests',
  rateLimit({ windowMs: 10 * 60_000, max: 5 }),
  validate({ body: orgRequestSchema }),
  postOrgRequest,
)

orgRouter.post('/activate', requireAuth, postActivate)

// The self-declared workplace - the weakest of the three links.
orgRouter.put('/affiliation', requireAuth, validate({ body: affiliationSchema }), putAffiliation)
orgRouter.delete('/affiliation', requireAuth, deleteAffiliation)

// Both of these attach the caller to an organisation, so both are rate
// limited: without it, either is an oracle. Ten tries a minute turns
// guessing a join code into something that takes years, and stops anyone
// walking phone numbers to learn who is on a roster.
orgRouter.post(
  '/claim-phone',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10 }),
  validate({ body: claimByPhoneSchema }),
  postClaimByPhone,
)

orgRouter.post(
  '/join',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10 }),
  validate({ body: joinByCodeSchema }),
  postJoinByCode,
)

orgRouter.get('/join-code', requireAuth, requireOrgAdmin, getJoinCode)
orgRouter.post('/join-code/rotate', requireAuth, requireOrgAdmin, postRotateJoinCode)

// The employee roster. Scoped to the caller's own organisation by
// requireOrgAdmin - the file carries no organisation, and the request is not
// allowed to name one.
orgRouter.get('/roster', requireAuth, requireOrgAdmin, getRoster)
orgRouter.post('/roster', requireAuth, requireOrgAdmin, singleCsv('file'), postRoster)
orgRouter.delete('/roster', requireAuth, requireOrgAdmin, deleteRoster)
