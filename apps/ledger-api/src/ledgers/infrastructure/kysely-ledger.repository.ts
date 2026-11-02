import { Injectable } from '@nestjs/common';
import { isUniqueViolation, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type { ILedgerRepository } from '../application/ports/ledger-repository.port.js';
import { LedgerAlreadyExistsError } from '../domain/ledger-already-exists.error.js';
import type { Ledger } from '../domain/ledger.entity.js';

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
}
