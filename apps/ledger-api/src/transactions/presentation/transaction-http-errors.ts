import { HttpException, HttpStatus } from '@nestjs/common';
import { ValueObjectError } from '@ledger/domain';
import { InsufficientFundsError } from '../domain/insufficient-funds.error.js';
import { InvalidPostingError } from '../domain/invalid-posting.error.js';
import { InvalidTransactionError } from '../domain/invalid-transaction.error.js';
import type { TransactionDomainError } from '../domain/transaction-domain.error.js';
import { TransactionNotFoundError } from '../domain/transaction-not-found.error.js';
import { TransactionReferenceAlreadyExistsError } from '../domain/transaction-reference-already-exists.error.js';

/**
 * Maps a domain error of this feature to the HTTP exception that the global
 * error filter already knows how to send.
 *
 * The error already knows its `code` (the domain owns it), so this file only
 * decides the HTTP status. The domain messages are safe for clients: they
 * never repeat a value of the request.
 *
 * A `ValueObjectError` (a bad address or asset code, an amount that is too
 * big) is a mistake in the request, so it is a 400, like the shape errors.
 */
export function toTransactionHttpException(
  error: TransactionDomainError | ValueObjectError,
): HttpException {
  return new HttpException(error.message, statusOf(error), { errorCode: error.code });
}

function statusOf(error: TransactionDomainError | ValueObjectError): HttpStatus {
  if (error instanceof TransactionNotFoundError) {
    return HttpStatus.NOT_FOUND;
  }
  if (error instanceof TransactionReferenceAlreadyExistsError) {
    return HttpStatus.CONFLICT;
  }
  // The request is well formed, but the money is not there. It can work later,
  // when the account has more, so it is not a 400.
  if (error instanceof InsufficientFundsError) {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }
  if (
    error instanceof InvalidPostingError ||
    error instanceof InvalidTransactionError ||
    error instanceof ValueObjectError
  ) {
    return HttpStatus.BAD_REQUEST;
  }
  // An error that has no status yet. A 500 is the safe answer: the core filter
  // hides the message and the code, and the error is logged as a failure.
  // When you add a transaction error, add its status above.
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
