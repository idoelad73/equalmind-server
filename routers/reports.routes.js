import { Router } from 'express'
import { requireAuth } from '../middlewares/requireAuth.js'
import { requireOrgAdmin } from '../middlewares/requireOrgAdmin.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import { validate } from '../middlewares/validate.js'
import {
  createReport,
  createReportSchema,
  listOrganizationReports,
  orgReportsQuerySchema,
} from '../controllers/reports.controller.js'

export const reportsRouter = Router()

reportsRouter.use(requireAuth)

reportsRouter.post(
  '/',
  rateLimit({ windowMs: 60_000, max: 10 }),
  validate({ body: createReportSchema }),
  createReport,
)

// The only way to read a report, and it is scoped to the caller's own
// organisation by requireOrgAdmin - which resolves that organisation from the
// database, not from the request. The response deliberately carries no
// reporter; see listOrganizationReports.
reportsRouter.get(
  '/organization',
  requireOrgAdmin,
  validate({ query: orgReportsQuerySchema }),
  listOrganizationReports,
)
