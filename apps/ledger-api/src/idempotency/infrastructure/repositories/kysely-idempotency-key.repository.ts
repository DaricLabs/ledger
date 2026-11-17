import { Injectable } from '@nestjs/common';
import { sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type {
  IIdempotencyClaim,
  IIdempotencyClaimInput,
  IIdempotencyKeyRepository,
} from '../../application/ports/idempotency-key-repository.port.js';
import { IDEMPOTENCY_KEY_TTL_SECONDS } from '../../domain/constants/idempotency-key.constant.js';
import { IdempotencyKeyReusedError } from '../../domain/errors/idempotency-key-reused.error.js';

/** Stateless: the transaction comes with every call, so this class needs nothing injected. */
@Injectable()
export class KyselyIdempotencyKeyRepository implements IIdempotencyKeyRepository {
  async claim(
    trx: TenantTransaction,
    ledgerId: string,
    input: IIdempotencyClaimInput,
  ): Promise<IIdempotencyClaim> {
    const k = unwrapTenantTransaction(trx);

    // The database clock is used for every time here, so the expiry check and
    // the expiry date never disagree, whatever the clock of the app says.
    const expiresAt = sql<Date>`now() + ${IDEMPOTENCY_KEY_TTL_SECONDS}::int * interval '1 second'`;

    // One statement, so there is no gap between "look" and "write":
    //
    // - No row with this key: the row is inserted, and the key is ours.
    // - A row that has expired: it is replaced, and the key is ours.
    // - A row that is still alive: nothing is written, and no row comes back.
    //
    // If another transaction has inserted the same key and has not ended yet,
    // this insert waits on the primary key until that transaction commits or
    // rolls back. After a commit it finds the committed row, so a live key is
    // never given twice. After a rollback it inserts the row itself. So no
    // request ever sees an "in progress" key.
    //
    // `organization_id` is the tenant set on the transaction (see the
    // transaction repository), so a key can only be written for it.
    const claimed = await k
      .insertInto('idempotency_keys')
      .values({
        organization_id: sql<string>`current_organization_id()`,
        ledger_id: ledgerId,
        operation: input.operation,
        key: input.key,
        request_hash: input.requestHash,
        transaction_id: input.transactionId,
        expires_at: expiresAt,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['organization_id', 'ledger_id', 'operation', 'key'])
          .doUpdateSet((eb) => ({
            request_hash: eb.ref('excluded.request_hash'),
            transaction_id: eb.ref('excluded.transaction_id'),
            created_at: sql<Date>`now()`,
            expires_at: eb.ref('excluded.expires_at'),
          }))
          .where('idempotency_keys.expires_at', '<=', sql<Date>`now()`),
      )
      .returning('transaction_id')
      .executeTakeFirst();
    if (claimed !== undefined) {
      return { replayed: false };
    }

    // A live row holds the key. This is a new statement, so it sees the row
    // that another transaction has committed in the meantime.
    const existing = await k
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'transaction_id'])
      .where('ledger_id', '=', ledgerId)
      .where('operation', '=', input.operation)
      .where('key', '=', input.key)
      .executeTakeFirstOrThrow();

    if (!existing.request_hash.equals(input.requestHash)) {
      throw new IdempotencyKeyReusedError();
    }
    return { replayed: true, transactionId: existing.transaction_id };
  }
}
