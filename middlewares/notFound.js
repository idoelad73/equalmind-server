import { AppError } from '../lib/AppError.js'

/** Reached only when no router matched. Mounted without a path: Express 5's
 *  path-to-regexp no longer accepts a bare '*' pattern. */
export function notFound(req, _res, next) {
  next(AppError.notFound(`No route for ${req.method} ${req.originalUrl}`))
}
