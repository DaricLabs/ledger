import type { TenantTransaction } from '@ledger/database';
import type { Ledger } from '../../domain/ledger.entity.js';

/** Storage of ledgers. Every method works inside a transaction the caller owns. */
export interface ILedgerRepository {
  /**
   * Saves a new ledger.
   *
   * @throws LedgerAlreadyExistsError If the organization already has a ledger
   * with this name.
   */
  insert(trx: TenantTransaction, ledger: Ledger): Promise<void>;
}

/** Nest DI token for {@link ILedgerRepository}. */
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
