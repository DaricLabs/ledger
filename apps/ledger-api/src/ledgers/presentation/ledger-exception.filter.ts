import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { AllExceptionsFilter } from '../../core/errors/all-exceptions.filter.js';
import { LedgerDomainError } from '../domain/ledger-domain.error.js';
import { toLedgerHttpException } from './ledger-http-errors.js';

/**
 * Turns the ledger domain errors into HTTP errors, for the controllers that
 * use it (`@UseFilters`). Every other error is left to the global filter.
 *
 * It catches the base class, so a new ledger error is caught without any
 * change here. Its status is decided in `ledger-http-errors.ts`.
 *
 * It does not build the response body itself. It maps the error and hands it
 * to the core filter, so there is still only one error body format.
 */
@Catch(LedgerDomainError)
export class LedgerExceptionFilter implements ExceptionFilter<LedgerDomainError> {
  private readonly coreFilter = new AllExceptionsFilter();

  catch(exception: LedgerDomainError, host: ArgumentsHost): void {
    this.coreFilter.catch(toLedgerHttpException(exception), host);
  }
}
