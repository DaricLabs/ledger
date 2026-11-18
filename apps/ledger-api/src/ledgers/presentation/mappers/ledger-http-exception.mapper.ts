import { HttpException, HttpStatus } from '@nestjs/common';
import { ValueObjectError } from '@ledger/domain';
import { InvalidLedgerNameError } from '../../domain/errors/invalid-ledger-name.error.js';
import { LedgerAlreadyExistsError } from '../../domain/errors/ledger-already-exists.error.js';
import type { LedgerDomainError } from '../../domain/errors/ledger-domain.error.js';
import { LedgerNotFoundError } from '../../domain/errors/ledger-not-found.error.js';

/**
 * Maps a ledger domain error to the HTTP exception that the global error
 * filter already knows how to send.
 *
 * The error already knows its `code` (the domain owns it), so this file only
 * decides the HTTP status. The domain messages are safe for clients: they
 * never contain metadata values, a metadata key only after it passed the key
 * limit, and a ledger name in a message has already passed the name pattern.
 *
 * A `ValueObjectError` here means bad or too big metadata. It is a mistake in
 * the request, so it is a 400, like the shape errors.
 */
export function toLedgerHttpException(error: LedgerDomainError | ValueObjectError): HttpException {
  return new HttpException(error.message, statusOf(error), { errorCode: error.code });
}

function statusOf(error: LedgerDomainError | ValueObjectError): HttpStatus {
  if (error instanceof LedgerNotFoundError) {
    return HttpStatus.NOT_FOUND;
  }
  if (error instanceof LedgerAlreadyExistsError) {
    return HttpStatus.CONFLICT;
  }
  if (error instanceof InvalidLedgerNameError || error instanceof ValueObjectError) {
    return HttpStatus.BAD_REQUEST;
  }
  // A ledger error that has no status yet. A 500 is the safe answer: the core
  // filter hides the message and the code, and the error is logged as a failure.
  // When you add a ledger error, add its status above.
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
