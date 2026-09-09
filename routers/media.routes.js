import { Router } from 'express'
import { requireAuth } from '../middlewares/requireAuth.js'
import { singleImage } from '../middlewares/upload.js'
import { validate } from '../middlewares/validate.js'
import {
  deleteAsset,
  deleteSchema,
  getUrl,
  postSignature,
  postUpload,
  signatureSchema,
  signedUrlSchema,
} from '../controllers/media.controller.js'

export const mediaRouter = Router()

// Every route here spends money or exposes an asset - none of it is public.
mediaRouter.use(requireAuth)

mediaRouter.post('/signature', validate({ body: signatureSchema }), postSignature)
mediaRouter.post('/upload', singleImage('photo'), postUpload)
mediaRouter.get('/url', validate({ query: signedUrlSchema }), getUrl)
mediaRouter.delete('/', validate({ body: deleteSchema }), deleteAsset)
