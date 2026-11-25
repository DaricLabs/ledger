import { z } from 'zod';
import { headerRef, parameterRef } from '../../../core/openapi/openapi-document.builder.js';
import type { IOpenApiModule } from '../../../core/openapi/openapi.type.js';
import { IDEMPOTENCY_KEY_TTL_SECONDS } from '../../domain/constants/idempotency-key.constant.js';
import { idempotencyKeySchema } from '../dto/idempotency-key.dto.js';

const IDEMPOTENCY_KEY = 'IdempotencyKey';
const IDEMPOTENT_REPLAYED = 'IdempotentReplayed';

export const idempotencyOpenApi: IOpenApiModule = {
  parameters: {
    [IDEMPOTENCY_KEY]: {
      in: 'header',
      name: 'Idempotency-Key',
      required: false,
      description:
        'Makes the request safe to repeat. With a key, the work is done once, however many ' +
        'times the same request is sent while the key is remembered: a repeat answers like ' +
        `the first call. A key is remembered for ${IDEMPOTENCY_KEY_TTL_SECONDS / 3600} hours, ` +
        'for one ledger. After that the same key starts a new request, so do not rely on a ' +
        'key to prevent a duplicate when you retry later than that. ' +
        'The same key with a different request is refused with `IDEMPOTENCY_KEY_REUSED`. ' +
        'A request that failed leaves no key, so it can be sent again with the same key. ' +
        'Without the header, every request does its work again.',
      schema: idempotencyKeySchema,
    },
  },
  headers: {
    [IDEMPOTENT_REPLAYED]: {
      description:
        '`true` when nothing ran this time: the response is the one of an earlier call with the ' +
        'same `Idempotency-Key`. The header is not there on the first call.',
      schema: z.literal('true'),
    },
  },
};

/** For the `parameters` of an operation that accepts an `Idempotency-Key`. */
export const IDEMPOTENCY_KEY_PARAMETER = parameterRef(IDEMPOTENCY_KEY);

/** For the `headers` of the response of an operation that accepts an `Idempotency-Key`. */
export const IDEMPOTENT_REPLAYED_HEADER_REF = headerRef(IDEMPOTENT_REPLAYED);
