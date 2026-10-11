import { Router } from 'express'
import { validate } from '../middlewares/validate.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import { requireAuth } from '../middlewares/requireAuth.js'
import { requireOrgAdmin } from '../middlewares/requireOrgAdmin.js'
import { requireOrgScope } from '../middlewares/requireOrgScope.js'
import { requireSystemAdmin } from '../middlewares/requireSystemAdmin.js'
import { singleRosterFile } from '../middlewares/upload.js'
import {
  affiliationSchema,
  claimByPhoneSchema,
  deleteAffiliation,
  deleteRoster,
  getJoinCode,
  getRoster,
  listOrganizations,
  getSmsOutbox,
  getTemplate,
  inviteRepresentativeSchema,
  joinByCodeSchema,
  notifySchema,
  orgRequestSchema,
  postActivate,
  postClaimByPhone,
  postJoinByCode,
  postInviteRepresentative,
  postOrgRequest,
  postRoster,
  postRosterNotify,
  postRotateJoinCode,
  putAffiliation,
  putTemplate,
  templateSchema,
} from '../controllers/org.controller.js'
import { getWorkers, workersQuerySchema } from '../controllers/workers.controller.js'

export const orgRouter = Router()

// The caller's own colleagues, for the "about whom" picker. Scoped inside
// getWorkers to the caller's own organisation - never one the request names.
// A merely declared workplace gets typed search only (lib/workers.js); the
// rate limit is what makes walking that search for the whole list slow.
orgRouter.get(
  '/workers',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 60 }),
  validate({ query: workersQuerySchema }),
  getWorkers,
)

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
// requireOrgScope, not requireOrgAdmin: Equalmind staff load rosters on an
// organisation's behalf, naming it with ?organizationId=. An org admin
// reaching the same route still gets their own organisation and nothing
// else - the request's value is ignored for them, not honoured.
orgRouter.get('/roster', requireAuth, requireOrgScope, getRoster)
orgRouter.post('/roster', requireAuth, requireOrgScope, singleRosterFile('file'), postRoster)
orgRouter.delete('/roster', requireAuth, requireOrgScope, deleteRoster)

// The picker behind the staff version of that screen.
orgRouter.get('/organizations', requireAuth, requireSystemAdmin, listOrganizations)

// Messaging the roster. Rate limited hard: this is the one endpoint that
// reaches people who never signed up, and Israel's Anti-Spam Law prices a
// mistake at up to NIS 1,000 per message. dryRun defaults to true.
orgRouter.post(
  '/roster/notify',
  requireAuth,
  // requireOrgScope, matching the roster routes: staff who can load a list
  // have to be able to invite the people on it, or the feature stops
  // halfway. They name the organisation with ?organizationId=; an org admin
  // still gets their own and the parameter is ignored for them.
  requireOrgScope,
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

// Equalmind staff inviting an organisation's representative. Rate limited:
// each call creates an account and sends mail, and Supabase's own sender is
// capped anyway - better to refuse here with a clear message than to be
// throttled upstream halfway through.
orgRouter.post(
  '/invite-representative',
  requireAuth,
  requireSystemAdmin,
  rateLimit({ windowMs: 60 * 60_000, max: 20 }),
  validate({ body: inviteRepresentativeSchema }),
  postInviteRepresentative,
)
