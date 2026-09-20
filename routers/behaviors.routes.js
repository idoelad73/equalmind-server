import { Router } from 'express'
import { requireAuth } from '../middlewares/requireAuth.js'
import { validate } from '../middlewares/validate.js'
import { behaviorsQuerySchema, getBehaviors } from '../controllers/behaviors.controller.js'

export const behaviorsRouter = Router()

// Catalogue data, but not public: the wording of the list is product work and
// there is no reason for it to be readable without an account.
behaviorsRouter.use(requireAuth)

behaviorsRouter.get('/', validate({ query: behaviorsQuerySchema }), getBehaviors)
