import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { toValidationException } from './to-validation-exception.js';

/**
 * Turns on `@Body({ schema })`, `@Query({ schema })` and `@Param({ schema })`
 * for the whole app. Without this pipe, the `schema` option does nothing.
 * Import it once, in `AppModule`.
 *
 * It is registered here and not with `app.useGlobalPipes` in `main.ts`, so
 * tests that build the app from `AppModule` get it too.
 */
@Module({
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () =>
        new StandardSchemaValidationPipe({ exceptionFactory: toValidationException }),
    },
  ],
})
export class ValidationModule {}
