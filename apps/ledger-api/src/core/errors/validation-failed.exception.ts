import { BadRequestException } from '@nestjs/common';
import type { ErrorDetailDto } from './error-response.dto.js';

/**
 * Thrown by the validation pipe when a request does not match its schema.
 * The error filter turns it into a `VALIDATION` response with `details`.
 */
export class ValidationFailedException extends BadRequestException {
  constructor(readonly details: ErrorDetailDto[]) {
    super('Request validation failed');
  }
}
