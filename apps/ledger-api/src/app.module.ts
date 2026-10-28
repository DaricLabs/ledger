import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './core/config/env.schema.js';
import { DatabaseModule } from './core/database/database.module.js';
import { ErrorsModule } from './core/errors/errors.module.js';
import { LoggingModule } from './core/logging/logging.module.js';
import { HealthModule } from './core/health/health.module.js';
import { ValidationModule } from './core/validation/validation.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    LoggingModule,
    ErrorsModule,
    ValidationModule,
    DatabaseModule,
    HealthModule,
  ],
})
export class AppModule {}
