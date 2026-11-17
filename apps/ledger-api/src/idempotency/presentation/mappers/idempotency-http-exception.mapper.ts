import { HttpException, HttpStatus } from '@nestjs/common';
import type { IdempotencyDomainError } from '../../domain/errors/idempotency-domain.error.js';
import { IdempotencyKeyReusedError } from '../../domain/errors/idempotency-key-reused.error.js';

/**
 * Maps a domain error of this module to the HTTP exception that the global
 * error filter already knows how to send.
 *
 * The error already knows its `code` (the domain owns it), so this file only
 * decides the HTTP status. The domain messages are safe for clients: they
 * never repeat the key.
 */
export function toIdempotencyHttpException(error: IdempotencyDomainError): HttpException {
  return new HttpException(error.message, statusOf(error), { errorCode: error.code });
}

function statusOf(error: IdempotencyDomainError): HttpStatus {
  // The request is well formed, but the key says it is the same request as
  // before, and it is not. 422 follows the IETF idempotency-key draft. It is
  // not a 409, which would mean "try again later".
  if (error instanceof IdempotencyKeyReusedError) {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }
  // An error that has no status yet. A 500 is the safe answer: the core filter
  // hides the message and the code, and the error is logged as a failure.
  // When you add an idempotency error, add its status above.
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
