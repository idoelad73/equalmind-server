import { z } from 'zod'
import { AppError } from '../lib/AppError.js'
import {
  createUploadSignature,
  getSignedUrl,
  remove,
  uploadBuffer,
} from '../lib/mediaProvider.js'

const SCOPES = ['reports']

export const signatureSchema = z.object({
  scope: z.enum(SCOPES).default('reports'),
})

export const signedUrlSchema = z.object({
  publicId: z.string().min(1).max(300),
  width: z.coerce.number().int().positive().max(2400).optional(),
})

export const deleteSchema = z.object({
  publicId: z.string().min(1).max(300),
})

/** Credentials for the browser to upload straight to Cloudinary. */
export function postSignature(req, res) {
  const { scope } = req.body
  res.json(createUploadSignature({ scope }))
}

/** Server-side upload: multer holds the file in memory, we stream it onward. */
export async function postUpload(req, res) {
  if (!req.file) throw AppError.badRequest('לא צורפה תמונה.')

  const media = await uploadBuffer(req.file.buffer, { scope: 'reports' })

  // No media table yet - the record is returned for the caller to persist
  // once the schema exists.
  res.status(201).json({ media })
}

/** Short-lived delivery URL for an authenticated asset. */
export function getUrl(req, res) {
  const { publicId, width } = req.validatedQuery
  // expiresInSeconds is null when Cloudinary token auth is not configured -
  // the URL is signed but does not expire. See lib/mediaProvider.js.
  res.json(getSignedUrl(publicId, { width }))
}

export async function deleteAsset(req, res) {
  const { publicId } = req.body
  res.json(await remove(publicId))
}
