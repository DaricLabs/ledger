import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

// Plain and short, because the id goes into every log line and a response header.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Returns the request id for one HTTP request and sends it back to the caller.
 *
 * The gateway sends `X-Request-Id`. If it is there and looks safe, it is reused,
 * so one id follows the request across services. Otherwise a new UUID is made.
 * The id is also set on the response, so callers can quote it in bug reports.
 *
 * Used as `genReqId` of pino-http.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
