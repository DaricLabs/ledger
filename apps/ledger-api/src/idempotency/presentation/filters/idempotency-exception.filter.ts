import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { AllExceptionsFilter } from '../../../core/errors/all-exceptions.filter.js';
import { IdempotencyDomainError } from '../../domain/errors/idempotency-domain.error.js';
import { toIdempotencyHttpException } from '../mappers/idempotency-http-exception.mapper.js';

/**
 * Turns the idempotency domain errors into HTTP errors, for the controllers
 * that use it (`@UseFilters`). Every other error is left to the global filter.
 *
 * It catches the base class, so a new idempotency error is caught without any
 * change here. Its status is decided in `idempotency-http-exception.mapper.ts`.
 *
 * It does not build the response body itself. It maps the error and hands it
 * to the core filter, so there is still only one error body format.
 */
@Catch(IdempotencyDomainError)
export class IdempotencyExceptionFilter implements ExceptionFilter<IdempotencyDomainError> {
  private readonly coreFilter = new AllExceptionsFilter();

  catch(exception: IdempotencyDomainError, host: ArgumentsHost): void {
    this.coreFilter.catch(toIdempotencyHttpException(exception), host);
  }
}
