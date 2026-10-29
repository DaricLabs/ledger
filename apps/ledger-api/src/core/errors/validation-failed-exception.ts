import { BadRequestException } from '@nestjs/common';
import type { ErrorDetail } from './error-response.js';

/**
 * Thrown by the validation pipe when a request does not match its schema.
 * The error filter turns it into a `VALIDATION` response with `details`.
 */
export class ValidationFailedException extends BadRequestException {
  constructor(readonly details: ErrorDetail[]) {
    super('Request validation failed');
  }
}
