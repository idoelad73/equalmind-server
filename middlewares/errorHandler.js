import { env } from '../config/env.js'

/**
 * Terminal error handler. Express 5 forwards rejected promises from async
 * handlers here automatically - no asyncHandler wrapper needed.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies this by arity.
export function errorHandler(error, req, res, _next) {
  const status = error.expected ? error.status : 500

  if (status >= 500) {
    console.error(`[${req.id}] ${req.method} ${req.originalUrl}`, error)
  }

  res.status(status).json({
    error: {
      code: error.expected ? error.code : 'internal_error',
      // Never leak an unexpected error's message: it can carry SQL or paths.
      message: error.expected ? error.message : 'Something went wrong on our side.',
      ...(error.details ? { details: error.details } : {}),
      requestId: req.id,
      ...(env.isProduction || error.expected ? {} : { stack: error.stack }),
    },
  })
}
