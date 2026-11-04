import { Injectable } from '@nestjs/common';
import { isUniqueViolation, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type { ILedgerRepository } from '../application/ports/ledger-repository.port.js';
import { LedgerAlreadyExistsError } from '../domain/ledger-already-exists.error.js';
import { Ledger, type LedgerMetadata } from '../domain/ledger.entity.js';

/** Postgres name of `unique (organization_id, name)` on `ledgers`. */
const NAME_UNIQUE_CONSTRAINT = 'ledgers_organization_id_name_key';

/** Stateless: the transaction comes with every call, so this class needs nothing injected. */
@Injectable()
export class KyselyLedgerRepository implements ILedgerRepository {
  async insert(trx: TenantTransaction, ledger: Ledger): Promise<void> {
    try {
      await unwrapTenantTransaction(trx)
        .insertInto('ledgers')
        .values({
          id: ledger.id,
          organization_id: ledger.organizationId,
          name: ledger.name,
          metadata: ledger.metadata,
          created_at: ledger.createdAt,
        })
        .execute();
    } catch (error) {
      // Only the name constraint means "already exists". An id clash or any
      // other database error is a real failure and must not be hidden.
      if (isUniqueViolation(error, NAME_UNIQUE_CONSTRAINT)) {
        throw new LedgerAlreadyExistsError(ledger.name);
      }
      throw error;
    }
  }

  async findByName(trx: TenantTransaction, name: string): Promise<Ledger | null> {
    // No `organization_id` filter on purpose: row-level security already limits
    // the rows to the organization of the transaction.
    const row = await unwrapTenantTransaction(trx)
      .selectFrom('ledgers')
      .select(['id', 'organization_id', 'name', 'metadata', 'created_at'])
      .where('name', '=', name)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }
    return Ledger.reconstitute({
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      // Safe cast: every ledger is saved through `Ledger.create`, which allows
      // string values only. The database itself only checks "a JSON object".
      metadata: row.metadata as LedgerMetadata,
      createdAt: row.created_at,
    });
  }
}
