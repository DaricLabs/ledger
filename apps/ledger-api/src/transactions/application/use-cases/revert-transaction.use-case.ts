import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@ledger/database';
import {
  ACCOUNT_BALANCE_REPOSITORY,
  type IAccountBalanceRepository,
} from '../../../accounts/application/ports/account-balance-repository.port.js';
import {
  IDEMPOTENCY_KEY_REPOSITORY,
  type IIdempotencyKeyRepository,
} from '../../../idempotency/application/ports/idempotency-key-repository.port.js';
import {
  ID_GENERATOR,
  type IIdGenerator,
} from '../../../ids/application/ports/id-generator.port.js';
import {
  LEDGER_LOG_WRITER,
  type ILedgerLogWriter,
} from '../../../journal/application/ports/ledger-log-writer.port.js';
import {
  OUTBOX_WRITER,
  type IOutboxWriter,
} from '../../../journal/application/ports/outbox-writer.port.js';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import {
  LEDGER_REPOSITORY,
  type ILedgerRepository,
} from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { TRANSACTION_LOG_TYPE } from '../../domain/constants/transaction-log-type.constant.js';
import { TRANSACTION_OPERATION } from '../../domain/constants/transaction-operation.constant.js';
import type { Transaction } from '../../domain/entities/transaction.entity.js';
import { TransactionNotFoundError } from '../../domain/errors/transaction-not-found.error.js';
import { toRevertTransactionRequestHash } from '../mappers/revert-transaction-request-hash.mapper.js';
import { toPostingsPayload } from '../mappers/transaction-payload.mapper.js';
import {
  TRANSACTION_REPOSITORY,
  type ITransactionRepository,
} from '../ports/transaction-repository.port.js';

export interface IRevertTransactionInput {
  organizationId: string;
  /** The name of the ledger the transaction is in. */
  ledgerName: string;
  /** The id of the transaction to revert (UUIDv7). */
  transactionId: string;
  /**
   * The `Idempotency-Key` of the request. Leave it out and the request runs
   * every time (a second revert of the same transaction is then refused). With
   * a key, the request runs once: the same key with the same request gives the
   * first result again, and the same key for another transaction is refused.
   */
  idempotencyKey?: string;
}

export interface IRevertTransactionResult {
  /** The NEW transaction that undoes the one in the request. */
  transaction: Transaction;
  /**
   * `true` when the request was done before with the same key. Nothing was
   * written, and `transaction` is the one the first call created.
   */
  replayed: boolean;
}

/**
 * Reverts a transaction: makes a new transaction that moves the same money
 * back, and marks the old one as reverted. The old one is never changed or
 * removed.
 *
 * In one tenant transaction it:
 *
 * 1. finds the ledger;
 * 2. claims the idempotency key, if the request has one (see below);
 * 3. finds the transaction and locks its row, so two reverts of the same
 *    transaction wait for each other, and the second one is refused;
 * 4. makes the reversing transaction in the domain (every posting goes the
 *    other way, in the opposite order), which refuses a transaction that was
 *    reverted before;
 * 5. locks every balance the reversal touches, in one fixed order, and applies
 *    the postings in the domain, which refuses a posting that takes more than
 *    an account has. That is the case when the money was spent after the
 *    original transaction: the revert fails, and nothing is forced;
 * 6. saves the new balances, the new transaction, and the revert mark;
 * 7. writes the `TRANSACTION_REVERTED` journal entry and the
 *    `ledger.transaction.reverted` outbox event.
 *
 * Either all of it is saved or none. The locks are taken in the same order as
 * in `CreateTransactionUseCase` (transaction row, then balances, then the
 * journal), so the two never wait for each other in a circle.
 *
 * The reversing transaction is a normal transaction: it has its own id, no
 * reference, and the time of the revert as `postedAt`. It is not backdated, so
 * the list of transactions stays in order. It can be reverted too.
 *
 * The journal entry and the event are about the NEW transaction (its id is the
 * `transactionId` of the entry and the `aggregateId` of the event), and their
 * payload holds the id of the transaction that was reverted. One entry is
 * enough to rebuild what happened: it has the postings of the new transaction.
 *
 * **Idempotency.** Works as in `CreateTransactionUseCase`: the key is claimed
 * in the same database transaction as the money, so a failed request leaves no
 * key and a retry runs again. The key is scoped to the `transactions.revert`
 * operation, so the same key text can also be used to create a transaction.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws TransactionNotFoundError If the ledger has no transaction with this id.
 * @throws TransactionAlreadyRevertedError If the transaction was reverted before.
 * @throws InsufficientFundsError If an account does not have enough money to
 * give back.
 * @throws IdempotencyKeyReusedError If the key was used for another request.
 */
@Injectable()
export class RevertTransactionUseCase {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IIdGenerator,
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(IDEMPOTENCY_KEY_REPOSITORY) private readonly idempotencyKeys: IIdempotencyKeyRepository,
    @Inject(ACCOUNT_BALANCE_REPOSITORY) private readonly balances: IAccountBalanceRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: ITransactionRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: IRevertTransactionInput): Promise<IRevertTransactionResult> {
    // Read once, before any `await`, like the other use cases: the hash and the
    // work must use the same value, even if the caller changes `input` meanwhile.
    const { transactionId } = input;
    const idempotency =
      input.idempotencyKey === undefined
        ? null
        : {
            operation: TRANSACTION_OPERATION.REVERT,
            key: input.idempotencyKey,
            requestHash: toRevertTransactionRequestHash({ transactionId }),
          };

    return this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      // The id is made before the key is claimed, because the key points to it.
      const reversalId = this.ids.next();
      if (idempotency !== null) {
        const claim = await this.idempotencyKeys.claim(trx, ledger.id, {
          ...idempotency,
          transactionId: reversalId,
        });
        if (claim.replayed) {
          return {
            transaction: await this.findReplayed(trx, ledger.id, claim.transactionId),
            replayed: true,
          };
        }
      }

      const original = await this.transactionRepository.lockById(trx, ledger.id, transactionId);
      if (original === null) {
        throw new TransactionNotFoundError(transactionId);
      }

      const reversal = original.reverse({ id: reversalId, at: new Date() });

      const current = await this.balances.lock(trx, ledger.id, reversal.touchedBalances());
      await this.balances.save(trx, ledger.id, reversal.applyTo(current));

      // The log and the outbox rows point to the new transaction row, and the
      // mark points to it too, so it is saved first.
      await this.transactionRepository.insert(trx, reversal);
      await this.transactionRepository.markReverted(trx, ledger.id, original.id, reversal);
      await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: TRANSACTION_LOG_TYPE.REVERTED,
        transactionId: reversal.id,
        payload: {
          revertedTransactionId: original.id,
          postedAt: reversal.postedAt.toISOString(),
          postings: toPostingsPayload(reversal.postings),
        },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        aggregateType: 'transaction',
        aggregateId: reversal.id,
        eventType: 'ledger.transaction.reverted',
        payload: {
          transactionId: reversal.id,
          revertedTransactionId: original.id,
          ledgerId: ledger.id,
          organizationId: reversal.organizationId,
          postedAt: reversal.postedAt.toISOString(),
          createdAt: reversal.createdAt.toISOString(),
          postings: toPostingsPayload(reversal.postings),
        },
      });

      return { transaction: reversal, replayed: false };
    });
  }

  /** Loads the transaction that a key points to. The key and the transaction are saved together. */
  private async findReplayed(
    trx: TenantTransaction,
    ledgerId: string,
    transactionId: string,
  ): Promise<Transaction> {
    const transaction = await this.transactionRepository.findById(trx, ledgerId, transactionId);
    if (transaction === null) {
      // The database refuses a key without its transaction (a foreign key), so
      // this is a bug. It must not be a 404: the caller did nothing wrong.
      throw new Error(`Idempotency key points to a missing transaction (${transactionId})`);
    }
    return transaction;
  }
}
