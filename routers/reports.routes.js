import { Router } from 'express'
import { requireAuth } from '../middlewares/requireAuth.js'
import { requireOrgAdmin } from '../middlewares/requireOrgAdmin.js'
import { requireSystemAdmin } from '../middlewares/requireSystemAdmin.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import { validate } from '../middlewares/validate.js'
import {
  createCustomReport,
  createCustomReportSchema,
  createReport,
  createReportSchema,
  listOrganizationReports,
  orgReportsQuerySchema,
} from '../controllers/reports.controller.js'
import {
  adminCreateSchema,
  createReportAsAdmin,
  deleteReport,
  listAllReports,
  listSchema,
  updateReport,
  updateSchema,
} from '../controllers/adminReports.controller.js'

export const reportsRouter = Router()

reportsRouter.use(requireAuth)

reportsRouter.post(
  '/',
  rateLimit({ windowMs: 60_000, max: 10 }),
  validate({ body: createReportSchema }),
  createReport,
)

// A Hook that is not in the catalogue. Separate from POST / so the catalogue
// path keeps deriving its space from the behaviour row.
reportsRouter.post(
  '/custom',
  rateLimit({ windowMs: 60_000, max: 10 }),
  validate({ body: createCustomReportSchema }),
  createCustomReport,
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

/* --------------------------------------------------- Equalmind staff only
 *
 * The whole catalogue of Hooks, with the reporter and the target both
 * readable. That is why these are a separate block behind
 * requireSystemAdmin rather than options on /organization, which answers a
 * different question for a different reader and must keep its own column
 * list.
 *
 * '/all' rather than '/' because '/' is already the filing endpoint, and a
 * GET and a POST that mean different things at one path is how the wrong
 * one gets called.
 */
reportsRouter.get(
  '/all',
  requireSystemAdmin,
  validate({ query: listSchema }),
  listAllReports,
)

reportsRouter.post(
  '/all',
  requireSystemAdmin,
  validate({ body: adminCreateSchema }),
  createReportAsAdmin,
)

reportsRouter.patch(
  '/:id',
  requireSystemAdmin,
  validate({ body: updateSchema }),
  updateReport,
)

reportsRouter.delete('/:id', requireSystemAdmin, deleteReport)
