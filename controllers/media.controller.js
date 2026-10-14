import { AppError } from '../lib/AppError.js'
import { uploadBuffer } from '../lib/mediaProvider.js'

/**
 * Media upload.
 *
 * One endpoint, on purpose. The provider can also mint signed URLs, issue
 * browser upload credentials and delete assets - and three endpoints that
 * did exactly that were removed because nothing called them and each one
 * let any signed-in account act on any asset by id. See media.routes.js.
 *
 * Where a delivery URL is needed, the endpoint that owns the row mints it:
 * listOrganizationReports and listAllReports exchange photo_public_id for a
 * fresh signed URL per request, and never return the publicId itself.
 */

/** Server-side upload: multer holds the file in memory, we stream it onward. */
export async function postUpload(req, res) {
  if (!req.file) throw AppError.badRequest('לא צורפה תמונה.')

  const media = await uploadBuffer(req.file.buffer, { scope: 'reports' })

  // No media table yet - the record is returned for the caller to persist
  // once the schema exists.
  res.status(201).json({ media })
}
