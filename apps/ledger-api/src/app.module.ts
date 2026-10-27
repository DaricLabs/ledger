import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.schema.js';
import { DatabaseModule } from './database/database.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    LoggingModule,
    DatabaseModule,
    HealthModule,
  ],
})
export class AppModule {}
