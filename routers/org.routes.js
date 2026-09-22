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
  getSmsOutbox,
  getTemplate,
  joinByCodeSchema,
  notifySchema,
  orgRequestSchema,
  postActivate,
  postClaimByPhone,
  postJoinByCode,
  postOrgRequest,
  postRoster,
  postRosterNotify,
  postRotateJoinCode,
  putAffiliation,
  putTemplate,
  templateSchema,
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

// Messaging the roster. Rate limited hard: this is the one endpoint that
// reaches people who never signed up, and Israel's Anti-Spam Law prices a
// mistake at up to NIS 1,000 per message. dryRun defaults to true.
orgRouter.post(
  '/roster/notify',
  requireAuth,
  requireOrgAdmin,
  rateLimit({ windowMs: 60 * 60_000, max: 5 }),
  validate({ body: notifySchema }),
  postRosterNotify,
)

orgRouter.get('/sms', requireAuth, requireOrgAdmin, getSmsOutbox)

// The invitation text. Read and written by the organisation's own admin;
// the length cap is enforced here and again by a check constraint, because
// an over-long template costs money on every recipient.
orgRouter.get('/template', requireAuth, requireOrgAdmin, getTemplate)
orgRouter.put(
  '/template',
  requireAuth,
  requireOrgAdmin,
  validate({ body: templateSchema }),
  putTemplate,
)
