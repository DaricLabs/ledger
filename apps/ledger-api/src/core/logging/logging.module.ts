import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerParams } from './logger-params.config.js';
import { Env } from '../config/env.config.js';

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
      useFactory: (config: ConfigService<Env, true>) =>
        buildLoggerParams({
          serviceName: SERVICE_NAME,
          level: config.get('LOG_LEVEL', { infer: true }),
          pretty: config.get('LOG_PRETTY', { infer: true }),
        }),
    }),
  ],
})
export class LoggingModule {}
