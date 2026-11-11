import { BadRequestException } from '@nestjs/common';
import type { IErrorDetail } from './error-response.dto.js';

/**
 * Thrown by the validation pipe when a request does not match its schema.
 * The error filter turns it into a `VALIDATION` response with `details`.
 */
export class ValidationFailedException extends BadRequestException {
  constructor(readonly details: IErrorDetail[]) {
    super('Request validation failed');
  }
}
