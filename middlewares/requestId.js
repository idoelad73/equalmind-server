import { randomUUID } from 'node:crypto'

/** Tag every request so a log line can be traced to a response. */
export function requestId(req, res, next) {
  req.id = req.get('x-request-id') || randomUUID()
  res.set('x-request-id', req.id)
  next()
}
