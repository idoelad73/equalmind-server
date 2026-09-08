import { AppError } from '../lib/AppError.js'

/**
 * Validate part of the request against a zod schema and replace it with the
 * parsed value, so controllers receive typed, trimmed, defaulted data.
 *
 *   router.post('/', validate({ body: createReportSchema }), controller)
 */
export function validate(schemas) {
  return (req, _res, next) => {
    for (const source of ['body', 'params', 'query']) {
      const schema = schemas[source]
      if (!schema) continue

      const result = schema.safeParse(req[source])
      if (!result.success) {
        return next(
          AppError.badRequest(
            'Request validation failed.',
            result.error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          ),
        )
      }
      // req.query is getter-only in Express 5 - assign to a side channel.
      if (source === 'query') req.validatedQuery = result.data
      else req[source] = result.data
    }
    next()
  }
}
