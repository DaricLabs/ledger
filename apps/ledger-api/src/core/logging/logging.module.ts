import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { LogLevel } from './log-levels.js';
import { buildLoggerParams } from './logger-params.js';

const SERVICE_NAME = 'ledger-api';

/**
 * Wires Pino into the app. Import it once, in `AppModule`, and nowhere else:
 * a second import would log every request twice.
 *
 * Code keeps using `Logger` from `@nestjs/common`. `main.ts` sends all of it
 * through Pino with `app.useLogger(app.get(Logger))`.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildLoggerParams({
          serviceName: SERVICE_NAME,
          level: config.getOrThrow<LogLevel>('LOG_LEVEL'),
          pretty: config.getOrThrow<boolean>('LOG_PRETTY'),
        }),
    }),
  ],
})
export class LoggingModule {}
