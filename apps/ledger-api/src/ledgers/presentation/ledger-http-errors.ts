import { HttpException, HttpStatus } from '@nestjs/common';
import { InvalidLedgerMetadataError } from '../domain/invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from '../domain/invalid-ledger-name.error.js';
import { LedgerAlreadyExistsError } from '../domain/ledger-already-exists.error.js';
import type { LedgerDomainError } from '../domain/ledger-domain.error.js';
import { LedgerNotFoundError } from '../domain/ledger-not-found.error.js';

/**
 * Maps a ledger domain error to the HTTP exception that the global error
 * filter already knows how to send.
 *
 * The error already knows its `code` (the domain owns it), so this file only
 * decides the HTTP status. The domain messages are safe for clients: they
 * never contain metadata values, and a ledger name in a message has already
 * passed the name pattern.
 */
export function toLedgerHttpException(error: LedgerDomainError): HttpException {
  return new HttpException(error.message, statusOf(error), { errorCode: error.code });
}

function statusOf(error: LedgerDomainError): HttpStatus {
  if (error instanceof LedgerNotFoundError) {
    return HttpStatus.NOT_FOUND;
  }
  if (error instanceof LedgerAlreadyExistsError) {
    return HttpStatus.CONFLICT;
  }
  if (error instanceof InvalidLedgerNameError || error instanceof InvalidLedgerMetadataError) {
    return HttpStatus.BAD_REQUEST;
  }
  // A ledger error that has no status yet. A 500 is the safe answer: the core
  // filter hides the message and the code, and the error is logged as a failure.
  // When you add a ledger error, add its status above.
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
