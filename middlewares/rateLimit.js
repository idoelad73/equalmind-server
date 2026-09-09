import { AppError } from '../lib/AppError.js'

/**
 * Small in-process rate limiter for unauthenticated endpoints.
 *
 * Deliberately not a dependency: one server instance, modest traffic, and the
 * only thing it has to stop is someone hammering the public request form.
 * If this ever runs on more than one instance the counter needs to move to a
 * shared store, because each process would keep its own tally.
 */
export function rateLimit({ windowMs = 60_000, max = 5, message } = {}) {
  const hits = new Map()

  // Drop expired buckets so the map cannot grow without bound.
  setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of hits) if (bucket.resetAt <= now) hits.delete(key)
  }, windowMs).unref()

  return (req, _res, next) => {
    const key = req.ip ?? 'unknown'
    const now = Date.now()
    const bucket = hits.get(key)

    if (!bucket || bucket.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    bucket.count += 1
    if (bucket.count > max) {
      return next(
        new AppError(429, 'rate_limited', message ?? 'יותר מדי בקשות. נסה/י שוב בעוד מספר דקות.'),
      )
    }
    next()
  }
}
