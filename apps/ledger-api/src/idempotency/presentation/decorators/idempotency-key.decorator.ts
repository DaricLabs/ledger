import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ValidationFailedException } from '../../../core/errors/validation-failed.exception.js';
import { IDEMPOTENCY_KEY_HEADER } from '../constants/idempotency-header.constant.js';
import { idempotencyKeySchema } from '../dto/idempotency-key.dto.js';

/** Name of the header as clients write it, for the `path` of the error detail. */
const HEADER_NAME = 'Idempotency-Key';

/**
 * Parameter decorator that gives a controller method the `Idempotency-Key`
 * header, checked. It is `undefined` when the request has no such header, so
 * the key is optional and a request without it works as it always did.
 *
 * It works as the `schema` option of `@Body()` does: a key that is empty or
 * has a wrong shape is a `VALIDATION` error (400) and the handler does not
 * run. The detail never repeats the value.
 *
 * @example
 * ```ts
 * @Post()
 * create(@IdempotencyKey() idempotencyKey: string | undefined) {}
 * ```
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const { headers } = context.switchToHttp().getRequest<Request>();
    const value = headers[IDEMPOTENCY_KEY_HEADER];
    if (value === undefined) {
      return undefined;
    }

    const result = idempotencyKeySchema.safeParse(value);
    if (!result.success) {
      throw new ValidationFailedException(
        result.error.issues.map((issue) => ({ path: HEADER_NAME, message: issue.message })),
      );
    }
    return result.data;
  },
);
