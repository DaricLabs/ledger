import type { StandardSchemaValidationPipe } from '@nestjs/common';
import { ValidationFailedException } from '../errors/validation-failed-exception.js';

type Issues = Parameters<
  NonNullable<
    NonNullable<ConstructorParameters<typeof StandardSchemaValidationPipe>[0]>['exceptionFactory']
  >
>[0];

/**
 * `exceptionFactory` of the validation pipe. Maps schema issues to our
 * `{ path, message }` details. A path segment is a key or `{ key }`;
 * an issue on the whole body has an empty path.
 */
export function toValidationException(issues: Issues): ValidationFailedException {
  return new ValidationFailedException(
    issues.map((issue) => ({
      path: (issue.path ?? [])
        .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
        .join('.'),
      message: issue.message,
    })),
  );
}
