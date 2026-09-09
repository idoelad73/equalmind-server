import { Router } from 'express'
import { validate } from '../middlewares/validate.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import {
  byIdSchema,
  getCompanies,
  getCompanyById,
  lookupSchema,
} from '../controllers/registry.controller.js'

export const registryRouter = Router()

// Public reference data, but served through us rather than exposed as a
// readable table: the limit is capped and the endpoint is rate limited, so
// nobody walks the whole registry through the autocomplete.
registryRouter.use(rateLimit({ windowMs: 60_000, max: 60 }))

registryRouter.get('/companies', validate({ query: lookupSchema }), getCompanies)
registryRouter.get('/companies/by-id', validate({ query: byIdSchema }), getCompanyById)
