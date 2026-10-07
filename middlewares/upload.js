import multer from 'multer'
import { env } from '../config/env.js'
import { AppError } from '../lib/AppError.js'

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
])

/**
 * Memory storage: the buffer is streamed straight to Cloudinary and never
 * touches disk. Uploads are capped at one file of UPLOAD_MAX_BYTES, so a large
 * request is refused while it streams rather than after it is fully buffered.
 *
 * The mime check here is a first filter, not proof - a client controls the
 * header it sends. Cloudinary re-encodes every upload (see UPLOAD_DEFAULTS),
 * which is what actually guarantees the stored asset is an image.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(AppError.badRequest('סוג הקובץ אינו נתמך. יש להעלות תמונה.'))
    }
    cb(null, true)
  },
})

/** Accepts one image on the `photo` field, with multer's errors translated. */
export function singleImage(field = 'photo') {
  const handler = upload.single(field)

  return (req, res, next) =>
    handler(req, res, (error) => {
      if (!error) return next()

      if (error instanceof multer.MulterError) {
        const message =
          error.code === 'LIMIT_FILE_SIZE'
            ? `הקובץ גדול מדי. הגודל המרבי הוא ${Math.round(env.UPLOAD_MAX_BYTES / 1024 / 1024)}MB.`
            : 'העלאת הקובץ נכשלה.'
        return next(AppError.badRequest(message))
      }
      next(error)
    })
}

/* --------------------------------------------------- roster spreadsheet */

// Browsers disagree about what a .csv is: Chrome on Windows often reports the
// Excel type because Excel owns the extension. The extension is checked too,
// and the content is parsed strictly either way - this filter only keeps
// obviously wrong files from being buffered.
const ROSTER_MIME = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])

const ROSTER_MAX_BYTES = 2 * 1024 * 1024 // ~40k employees

// .xlsx only, not the legacy binary .xls: the reader handles the modern
// format, and Excel saves as .xlsx by default.
const rosterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ROSTER_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const looksRight = /\.(csv|xlsx)$/i.test(file.originalname ?? '')
    if (!looksRight || !ROSTER_MIME.has(file.mimetype)) {
      return cb(AppError.badRequest('יש להעלות קובץ אקסל (xlsx) או CSV.'))
    }
    cb(null, true)
  },
})

/** Accepts one roster file (.xlsx or .csv) on the `file` field. */
export function singleRosterFile(field = 'file') {
  const handler = rosterUpload.single(field)

  return (req, res, next) =>
    handler(req, res, (error) => {
      if (!error) return next()

      if (error instanceof multer.MulterError) {
        const message =
          error.code === 'LIMIT_FILE_SIZE'
            ? `הקובץ גדול מדי. הגודל המרבי הוא ${Math.round(ROSTER_MAX_BYTES / 1024 / 1024)}MB.`
            : 'העלאת הקובץ נכשלה.'
        return next(AppError.badRequest(message))
      }
      next(error)
    })
}
