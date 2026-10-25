import { Inject, Logger, Module } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertSafeRuntimeRole, createDb } from '@ledger/database/storage';
import type { LedgerDatabase } from '@ledger/database/storage';
import type { Env } from '../config/env.schema.js';
import { KYSELY_DB } from './database.tokens.js';

// TODO(logger): revisit when the logging decision is made
const logger = new Logger('Database');

@Module({
  providers: [
    {
      provide: KYSELY_DB,
      inject: [ConfigService],
      // One pool for the whole process. The pool is lazy: no connection opens here.
      useFactory: (config: ConfigService<Env, true>): LedgerDatabase =>
        createDb(config.get('LEDGER_RUNTIME_DATABASE_URL', { infer: true }), {
          onPoolError: (error) =>
            logger.error(`Idle database connection failed: ${error.message}`, error.stack),
        }),
    },
  ],
  exports: [KYSELY_DB],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(KYSELY_DB) private readonly db: LedgerDatabase) {}

  /** Runs on startup. If the role is unsafe, the app does not start. */
  async onModuleInit(): Promise<void> {
    try {
      await assertSafeRuntimeRole(this.db);
    } catch (error) {
      await this.db.destroy(); // startup failed, so close the pool before rethrowing
      throw error;
    }
  }

  /** Runs after the HTTP server has stopped, so no request can still use the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
