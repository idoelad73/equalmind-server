import { Router } from 'express'
import { validate } from '../middlewares/validate.js'
import { rateLimit } from '../middlewares/rateLimit.js'
import {
  byIdSchema,
  getCompanies,
  getCompanyById,
  getLocalities,
  getLocalityByCoords,
  getPlaces,
  localityCoordsSchema,
  localitySearchSchema,
  lookupSchema,
  placeSearchSchema,
} from '../controllers/registry.controller.js'
import { requireAuth } from '../middlewares/requireAuth.js'

export const registryRouter = Router()

// Public reference data, but served through us rather than exposed as a
// readable table: the limit is capped and the endpoint is rate limited, so
// nobody walks the whole registry through the autocomplete.
registryRouter.use(rateLimit({ windowMs: 60_000, max: 60 }))

registryRouter.get('/companies', validate({ query: lookupSchema }), getCompanies)
registryRouter.get('/companies/by-id', validate({ query: byIdSchema }), getCompanyById)
registryRouter.get('/localities', validate({ query: localitySearchSchema }), getLocalities)
registryRouter.get(
  '/localities/by-coords',
  validate({ query: localityCoordsSchema }),
  getLocalityByCoords,
)

// Signed-in only, unlike the rest of this router: it proxies a free
// third-party service, and an open proxy to it is one nobody else should be
// able to run up on our behalf.
registryRouter.get('/places', requireAuth, validate({ query: placeSearchSchema }), getPlaces)
