import { HttpException, HttpStatus } from '@nestjs/common';
import type { AccountDomainError } from '../domain/account-domain.error.js';
import { AccountNotFoundError } from '../domain/account-not-found.error.js';
import { InsufficientFundsError } from '../domain/insufficient-funds.error.js';

/**
 * Maps a domain error of this feature to the HTTP exception that the global
 * error filter already knows how to send.
 *
 * The error already knows its `code` (the domain owns it), so this file only
 * decides the HTTP status. The domain messages are safe for clients: they
 * never repeat a value of the request that has not passed its pattern.
 */
export function toAccountHttpException(error: AccountDomainError): HttpException {
  return new HttpException(error.message, statusOf(error), { errorCode: error.code });
}

function statusOf(error: AccountDomainError): HttpStatus {
  if (error instanceof AccountNotFoundError) {
    return HttpStatus.NOT_FOUND;
  }
  // The request is well formed, but the money is not there. It can work later,
  // when the account has more, so it is not a 400.
  if (error instanceof InsufficientFundsError) {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }
  // An account error that has no status yet. A 500 is the safe answer: the
  // core filter hides the message and the code, and the error is logged as a
  // failure. When you add an account error, add its status above.
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
