import { Module } from '@nestjs/common';
import { IDEMPOTENCY_KEY_REPOSITORY } from './application/ports/idempotency-key-repository.port.js';
import { KyselyIdempotencyKeyRepository } from './infrastructure/repositories/kysely-idempotency-key.repository.js';

/**
 * Lets an operation run only once for one `Idempotency-Key`. A feature imports
 * this module and injects `IDEMPOTENCY_KEY_REPOSITORY`. It depends on no
 * feature and on nothing else in the app.
 */
@Module({
  providers: [{ provide: IDEMPOTENCY_KEY_REPOSITORY, useClass: KyselyIdempotencyKeyRepository }],
  exports: [IDEMPOTENCY_KEY_REPOSITORY],
})
export class IdempotencyModule {}
