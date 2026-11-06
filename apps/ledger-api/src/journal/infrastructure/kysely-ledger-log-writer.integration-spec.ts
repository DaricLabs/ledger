import {
  createDb,
  SqlState,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import { Uuidv7IdGenerator } from '../../ids/infrastructure/uuidv7-id-generator.js';
import { KyselyLedgerLogWriter } from './kysely-ledger-log-writer.js';

// The writer has no constructor arguments, so these tests do not need Nest.
// Every test uses a new organization id, so tests never see each other's rows.
// The rows below are written with plain SQL on purpose: the journal must not
// depend on any feature.
const ids = new Uuidv7IdGenerator();
const writer = new KyselyLedgerLogWriter();
let db: LedgerDatabase;

beforeAll(() => {
  // The runtime role, like the app. Row-level security applies to it.
  db = createDb(process.env.LEDGER_RUNTIME_DATABASE_URL!, {
    onPoolError: (error) => console.error(error),
  });
});

afterAll(() => db.destroy());

/** Adds a ledger to the organization of the transaction and returns its id. */
async function insertLedger(trx: TenantTransaction, organizationId: string): Promise<string> {
  const id = ids.next();
  await unwrapTenantTransaction(trx)
    .insertInto('ledgers')
    .values({ id, organization_id: organizationId, name: 'main' })
    .execute();
  return id;
}

/** Adds a transaction row (no postings) to a ledger and returns its id. */
async function insertTransaction(
  trx: TenantTransaction,
  organizationId: string,
  ledgerId: string,
): Promise<string> {
  const id = ids.next();
  await unwrapTenantTransaction(trx)
    .insertInto('transactions')
    .values({ id, organization_id: organizationId, ledger_id: ledgerId, reference: null })
    .execute();
  return id;
}

describe('KyselyLedgerLogWriter.append', () => {
  it('writes an entry that is not about a transaction, with the next seq of the ledger', async () => {
    const organizationId = ids.next();

    const logs = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await writer.append(trx, { ledgerId, type: 'SOMETHING_HAPPENED', payload: { a: 1 } });
      await writer.append(trx, { ledgerId, type: 'SOMETHING_ELSE_HAPPENED', payload: {} });
      return unwrapTenantTransaction(trx)
        .selectFrom('ledger_logs')
        .selectAll()
        .where('ledger_id', '=', ledgerId)
        .orderBy('seq')
        .execute();
    });

    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      organization_id: organizationId,
      seq: '1',
      type: 'SOMETHING_HAPPENED',
      transaction_id: null,
      payload: { a: 1 },
    });
    expect(logs[1]).toMatchObject({ seq: '2', transaction_id: null });
  });

  it('links the entry to a transaction when a transactionId is given', async () => {
    const organizationId = ids.next();

    const logs = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      const transactionId = await insertTransaction(trx, organizationId, ledgerId);
      await writer.append(trx, {
        ledgerId,
        type: 'SOMETHING_HAPPENED',
        transactionId,
        payload: {},
      });
      return unwrapTenantTransaction(trx)
        .selectFrom('ledger_logs')
        .select(['transaction_id'])
        .where('ledger_id', '=', ledgerId)
        .execute()
        .then((rows) => ({ rows, transactionId }));
    });

    expect(logs.rows).toEqual([{ transaction_id: logs.transactionId }]);
  });

  it('refuses a transactionId that does not exist (foreign key)', async () => {
    const organizationId = ids.next();

    const error = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await writer.append(trx, {
        ledgerId,
        type: 'SOMETHING_HAPPENED',
        transactionId: ids.next(),
        payload: {},
      });
    }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: SqlState.ForeignKeyViolation });
  });

  it('refuses a type that the database does not accept', async () => {
    const organizationId = ids.next();

    const error = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await writer.append(trx, { ledgerId, type: 'not upper snake case', payload: {} });
    }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: SqlState.CheckViolation });
  });
});
