import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ValueObjectError } from '@ledger/domain';
import { AllExceptionsFilter } from '../../../core/errors/all-exceptions.filter.js';
import { LedgerDomainError } from '../../domain/errors/ledger-domain.error.js';
import { toLedgerHttpException } from '../mappers/ledger-http-exception.mapper.js';

/**
 * Turns the ledger domain errors, and the errors of the shared value objects
 * (bad or too big metadata), into HTTP errors, for the controllers that use it
 * (`@UseFilters`). Every other error is left to the global filter.
 *
 * It catches the base classes, so a new error is caught without any change
 * here. Its status is decided in `ledger-http-exception.mapper.ts`.
 *
 * It does not build the response body itself. It maps the error and hands it
 * to the core filter, so there is still only one error body format.
 */
@Catch(LedgerDomainError, ValueObjectError)
export class LedgerExceptionFilter implements ExceptionFilter<
  LedgerDomainError | ValueObjectError
> {
  private readonly coreFilter = new AllExceptionsFilter();

  catch(exception: LedgerDomainError | ValueObjectError, host: ArgumentsHost): void {
    this.coreFilter.catch(toLedgerHttpException(exception), host);
  }
}
