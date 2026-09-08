/**
 * Errors thrown deliberately by our own code. Anything else reaching the
 * error handler is treated as an unexpected 500 and not shown to the client.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    this.expected = true
  }

  static badRequest(message, details) {
    return new AppError(400, 'bad_request', message, details)
  }
  static unauthorized(message = 'Authentication required.') {
    return new AppError(401, 'unauthorized', message)
  }
  static forbidden(message = 'You do not have access to this resource.') {
    return new AppError(403, 'forbidden', message)
  }
  static notFound(message = 'Resource not found.') {
    return new AppError(404, 'not_found', message)
  }
  static conflict(message, details) {
    return new AppError(409, 'conflict', message, details)
  }
}
