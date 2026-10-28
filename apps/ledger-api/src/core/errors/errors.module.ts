import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerErrorInterceptor } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

/**
 * Registers the app-wide error filter and the interceptor that puts the
 * error on the request log line. Import it once, in `AppModule`.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggerErrorInterceptor },
  ],
})
export class ErrorsModule {}
