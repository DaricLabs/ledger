import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ValueObjectError } from '@ledger/domain';
import { AllExceptionsFilter } from '../../core/errors/all-exceptions.filter.js';
import { TransactionDomainError } from '../domain/transaction-domain.error.js';
import { toTransactionHttpException } from './transaction-http-errors.js';

/**
 * Turns the transaction domain errors, and the errors of the shared value
 * objects (a bad address, asset code or amount), into HTTP errors, for the
 * controllers that use it (`@UseFilters`). Every other error is left to the
 * global filter.
 *
 * It catches the base classes, so a new error is caught without any change
 * here. Its status is decided in `transaction-http-errors.ts`.
 *
 * It does not build the response body itself. It maps the error and hands it
 * to the core filter, so there is still only one error body format.
 */
@Catch(TransactionDomainError, ValueObjectError)
export class TransactionExceptionFilter implements ExceptionFilter<
  TransactionDomainError | ValueObjectError
> {
  private readonly coreFilter = new AllExceptionsFilter();

  catch(exception: TransactionDomainError | ValueObjectError, host: ArgumentsHost): void {
    this.coreFilter.catch(toTransactionHttpException(exception), host);
  }
}
