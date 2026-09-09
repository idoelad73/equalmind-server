import { AppError } from './AppError.js'
import { assertCloudinaryConfigured, cloudinary, UPLOAD_DEFAULTS } from './cloudinary.js'
import { env } from '../config/env.js'

/**
 * The one place the rest of the server talks to media storage.
 *
 * Controllers never import the Cloudinary SDK directly. Swapping the backend
 * later - Cloudinary is convenient but expensive at volume, and Cloudflare R2
 * is cheaper and private by default - means reimplementing these four
 * functions, not touching every call site.
 *
 * Nothing here writes to the database. Callers persist the object returned by
 * `toMediaRecord()` once the media table exists.
 */

const SIGNED_URL_TTL_SECONDS = 300

/** Stream a buffer (from multer) into Cloudinary. */
export function uploadBuffer(buffer, { scope = 'reports' } = {}) {
  assertCloudinaryConfigured()
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { ...UPLOAD_DEFAULTS, folder: `${env.CLOUDINARY_FOLDER}/${scope}` },
      (error, result) => {
        if (error) return reject(new AppError(502, 'upload_failed', 'העלאת התמונה נכשלה.'))
        resolve(toMediaRecord(result))
      },
    )
    stream.end(buffer)
  })
}

/**
 * Credentials for a browser to upload straight to Cloudinary, so image bytes
 * never pass through this server. Preferred once the client is wired for it:
 * a $7 instance should not be proxying photo traffic.
 *
 * Deliberately a signature and not an unsigned upload preset - a preset name
 * is a credential to anyone who finds it in the bundle.
 */
export function createUploadSignature({ scope = 'reports' } = {}) {
  assertCloudinaryConfigured()
  const timestamp = Math.round(Date.now() / 1000)
  const folder = `${env.CLOUDINARY_FOLDER}/${scope}`

  // Only these params are signed, and Cloudinary rejects the upload if the
  // client sends anything different.
  const params = {
    timestamp,
    folder,
    type: UPLOAD_DEFAULTS.type,
    transformation: 'c_limit,h_2400,w_2400,q_auto:good',
  }

  return {
    ...params,
    signature: cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET),
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  }
}

/**
 * A delivery URL for an authenticated asset.
 *
 * Store `publicId` in the database, never a URL.
 *
 * Expiry is conditional, and the caller is told which it got:
 * - With CLOUDINARY_AUTH_TOKEN_KEY set, the URL carries a Cloudinary auth
 *   token and genuinely expires after `ttlSeconds`.
 * - Without it, the URL is *signed but permanent*. It cannot be guessed, and
 *   it is refused without the signature, but anyone who obtains it keeps
 *   access until the asset is deleted. Cloudinary's plain `expires_at` on a
 *   signed URL is silently ignored - token auth is the only real mechanism,
 *   and it is a paid add-on.
 */
export function getSignedUrl(publicId, { width, ttlSeconds = SIGNED_URL_TTL_SECONDS } = {}) {
  assertCloudinaryConfigured()
  if (!publicId) throw AppError.badRequest('Missing publicId.')

  const transformation = width
    ? [{ width, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
    : [{ quality: 'auto', fetch_format: 'auto' }]

  const expiring = Boolean(env.CLOUDINARY_AUTH_TOKEN_KEY)

  const url = cloudinary.url(publicId, {
    type: 'authenticated',
    resource_type: 'image',
    sign_url: true,
    secure: true,
    transformation,
    ...(expiring
      ? {
          auth_token: {
            key: env.CLOUDINARY_AUTH_TOKEN_KEY,
            duration: ttlSeconds,
          },
        }
      : {}),
  })

  return { url, expiresInSeconds: expiring ? ttlSeconds : null }
}

/** Permanent removal - used by cleanup jobs and by erasure requests. */
export async function remove(publicId) {
  assertCloudinaryConfigured()
  if (!publicId) throw AppError.badRequest('Missing publicId.')

  const result = await cloudinary.uploader.destroy(publicId, {
    type: 'authenticated',
    resource_type: 'image',
    invalidate: true,
  })
  return { publicId, result: result.result }
}

/**
 * The shape a media row will take. Kept here so the columns are decided once,
 * in the module that knows what Cloudinary returns.
 */
export function toMediaRecord(result) {
  return {
    provider: 'cloudinary',
    publicId: result.public_id,
    version: result.version,
    format: result.format,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    createdAt: result.created_at,
  }
}
