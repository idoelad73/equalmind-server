import { v2 as cloudinary } from 'cloudinary'
import { env } from '../config/env.js'
import { AppError } from './AppError.js'

/**
 * Cloudinary SDK, configured once for the process.
 *
 * `secure: true` forces https on every generated URL - without it the SDK
 * still emits http links, which browsers block on an https page.
 */
export const isCloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
)

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
})

export { cloudinary }

/** Guard for every media operation, so a missing key is a clear 503. */
export function assertCloudinaryConfigured() {
  if (!isCloudinaryConfigured) {
    throw new AppError(
      503,
      'media_unconfigured',
      'אחסון התמונות אינו מוגדר. יש להשלים את משתני CLOUDINARY_* בקובץ server/.env.',
    )
  }
}

/**
 * Report photos are evidence about identifiable people, so none of
 * Cloudinary's public defaults apply here.
 *
 * - `type: 'authenticated'` keeps assets off public URLs. Delivery needs a
 *   signed, time-limited link minted by the server.
 * - The incoming transformation re-encodes the image before it is stored,
 *   which caps dimensions AND strips EXIF. Phone photos carry GPS, timestamps
 *   and device ids; on a platform built for anonymous reporting that metadata
 *   can locate the reporter's home or workplace.
 */
export const UPLOAD_DEFAULTS = {
  folder: env.CLOUDINARY_FOLDER,
  resource_type: 'image',
  type: 'authenticated',
  overwrite: false,
  unique_filename: true,
  use_filename: false,
  // Applied before storage, so the original never lands with metadata intact.
  transformation: [{ width: 2400, height: 2400, crop: 'limit', quality: 'auto:good' }],
}
