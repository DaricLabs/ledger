import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { AllExceptionsFilter } from '../../core/errors/all-exceptions.filter.js';
import { AccountDomainError } from '../domain/account-domain.error.js';
import { toAccountHttpException } from './account-http-errors.js';

/**
 * Turns the account domain errors into HTTP errors, for the controllers that
 * use it (`@UseFilters`). Every other error is left to the global filter.
 *
 * It catches the base class, so a new account error is caught without any
 * change here. Its status is decided in `account-http-errors.ts`.
 *
 * It does not build the response body itself. It maps the error and hands it
 * to the core filter, so there is still only one error body format.
 */
@Catch(AccountDomainError)
export class AccountExceptionFilter implements ExceptionFilter<AccountDomainError> {
  private readonly coreFilter = new AllExceptionsFilter();

  catch(exception: AccountDomainError, host: ArgumentsHost): void {
    this.coreFilter.catch(toAccountHttpException(exception), host);
  }
}
