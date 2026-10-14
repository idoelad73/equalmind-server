import { Router } from 'express'
import { requireAuth } from '../middlewares/requireAuth.js'
import { singleImage } from '../middlewares/upload.js'
import { postUpload } from '../controllers/media.controller.js'

export const mediaRouter = Router()

// Uploading spends money and reaches storage, so it is not public.
mediaRouter.use(requireAuth)

mediaRouter.post('/upload', singleImage('photo'), postUpload)

/*
 * GONE, deliberately - do not re-add without a caller and a scope:
 *
 *   GET /url      minted a signed delivery URL for ANY publicId, to any
 *                 signed-in account. Report photos upload as `authenticated`
 *                 precisely so they are not public; this handed links to
 *                 them out, which defeated that and bypassed the scoping in
 *                 listOrganizationReports.
 *
 *   DELETE /      deleted ANY asset by publicId, to any signed-in account -
 *                 including the photo attached to someone else's Hook,
 *                 which is evidence about an identifiable person.
 *
 *   POST /signature  handed Cloudinary upload credentials to any signed-in
 *                 account.
 *
 * Nothing in the client ever called them. Where a URL is actually needed,
 * the endpoint that owns the row mints it: listOrganizationReports and
 * listAllReports exchange photo_public_id for a fresh signed URL per
 * request, and never return the publicId itself.
 *
 * If one of these comes back, it needs an ownership check - a caller may
 * only touch an asset referenced by a report they filed, or one in their
 * own organisation if they administer it - and a test for that check.
 */
