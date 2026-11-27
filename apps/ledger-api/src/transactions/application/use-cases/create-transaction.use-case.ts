import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@ledger/database';
import { AccountAddress, AssetCode, Metadata, Money, type MetadataEntries } from '@ledger/domain';
import {
  ACCOUNT_BALANCE_REPOSITORY,
  type IAccountBalanceRepository,
} from '../../../accounts/application/ports/account-balance-repository.port.js';
import { AccountBalance } from '../../../accounts/domain/entities/account-balance.entity.js';
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
import { Transaction } from '../../domain/entities/transaction.entity.js';
import { Posting } from '../../domain/value-objects/posting.vo.js';
import { toCreateTransactionRequestHash } from '../mappers/create-transaction-request-hash.mapper.js';
import { toPostingsPayload } from '../mappers/transaction-payload.mapper.js';
import {
  TRANSACTION_REPOSITORY,
  type ITransactionRepository,
} from '../ports/transaction-repository.port.js';

export interface IPostingInput {
  source: string;
  destination: string;
  asset: string;
  /** In the smallest unit of the asset (cents for USD). Must be above zero. */
  amount: bigint;
}

export interface ICreateTransactionInput {
  organizationId: string;
  /** The name of the ledger the transaction goes into. */
  ledgerName: string;
  /** The id the caller gives to the transaction. Leave it out for none. */
  reference?: string;
  postings: readonly IPostingInput[];
  /** Free-form key/value pairs saved with the transaction. Leave it out for none. */
  metadata?: MetadataEntries;
  /**
   * The `Idempotency-Key` of the request. Leave it out and the request runs
   * every time. With a key, the request runs once: the same key with the same
   * request gives the first transaction again, and the same key with another
   * request is refused.
   */
  idempotencyKey?: string;
}

export interface ICreateTransactionResult {
  transaction: Transaction;
  /**
   * `true` when the request was done before with the same key. Nothing was
   * written, and `transaction` is the one the first call created.
   */
  replayed: boolean;
}

/**
 * Creates a transaction: moves money between accounts, all postings or none.
 *
 * In one tenant transaction it:
 *
 * 1. finds the ledger;
 * 2. claims the idempotency key, if the request has one (see below);
 * 3. creates the accounts and balances that do not exist yet (`world` may go
 *    below zero, every other account may not);
 * 4. locks every balance the postings touch, in one fixed order, so two
 *    transactions that share accounts wait for each other and never deadlock;
 * 5. applies the postings to the locked balances in the domain, which refuses
 *    a posting that takes more than an account has;
 * 6. saves the new balances, the transaction and its postings;
 * 7. writes the `TRANSACTION_CREATED` journal entry and the
 *    `ledger.transaction.created` outbox event. Both carry the metadata, so
 *    the journal alone can rebuild the transaction (later edits of the
 *    metadata have their own entries).
 *
 * Either all of it is saved or none. The journal entry takes a lock on the
 * ledger until the transaction ends, so the transactions of one ledger commit
 * one after the other, in the order of their journal entries. That is why the
 * journal comes last: a transaction holds this lock for as short a time as it
 * can, and no transaction waits for a balance while it holds the lock.
 *
 * **Idempotency.** With an `idempotencyKey`, the key is claimed in the same
 * database transaction as the money. So the key is saved if and only if the
 * transaction is saved: a request that fails or crashes leaves no key, and a
 * retry runs again. If the key was already used for the same request, nothing
 * else runs, and the first transaction is returned with `replayed: true`. If
 * it was used for another request, the call fails. Two calls with the same key
 * at the same time never both run: the second waits for the first. The
 * metadata is part of the request: the same key with other metadata is another
 * request. A repeat answers with the metadata of the first call, even if the
 * metadata was edited after that.
 *
 * The domain checks the postings and the metadata before any transaction is
 * opened. Domain
 * errors (`InvalidPostingError`, `InvalidTransactionError`,
 * `InsufficientFundsError`, `TransactionReferenceAlreadyExistsError`,
 * `IdempotencyKeyReusedError` and the errors of the value objects of
 * `@ledger/domain`, like `InvalidMetadataError` and
 * `MetadataLimitExceededError`) pass through unchanged. The presentation layer turns them
 * into HTTP responses.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws IdempotencyKeyReusedError If the key was used for another request.
 */
@Injectable()
export class CreateTransactionUseCase {
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

  async execute(input: ICreateTransactionInput): Promise<ICreateTransactionResult> {
    // Checked first, because it needs no database. The reference is read once,
    // here, before any `await`: the hash and the transaction must use the same
    // value, even if the caller changes `input` while we wait for the database.
    const reference = input.reference ?? null;
    const postings = input.postings.map(toPosting);
    // `Metadata.of` copies and checks the input, so what we hash is what we save.
    const metadata = Metadata.of(input.metadata ?? {});
    const idempotency =
      input.idempotencyKey === undefined
        ? null
        : {
            operation: TRANSACTION_OPERATION.CREATE,
            key: input.idempotencyKey,
            requestHash: toCreateTransactionRequestHash({
              reference,
              postings: input.postings,
              metadata: metadata.entries,
            }),
          };

    return this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      // The id is made before the key is claimed, because the key points to it.
      const transactionId = this.ids.next();
      if (idempotency !== null) {
        const claim = await this.idempotencyKeys.claim(trx, ledger.id, {
          ...idempotency,
          transactionId,
        });
        if (claim.replayed) {
          return {
            transaction: await this.findReplayed(trx, ledger.id, claim.transactionId, metadata),
            replayed: true,
          };
        }
      }

      const now = new Date();
      const transaction = Transaction.create({
        id: transactionId,
        organizationId: input.organizationId,
        ledgerId: ledger.id,
        reference,
        postings,
        metadata,
        postedAt: now,
        createdAt: now,
      });

      const keys = transaction.touchedBalances();
      await this.balances.open(
        trx,
        ledger.id,
        keys.map((key) => AccountBalance.open(key.address, key.asset)),
      );
      const current = await this.balances.lock(trx, ledger.id, keys);
      await this.balances.save(trx, ledger.id, transaction.applyTo(current));

      // The log and the outbox rows point to the transaction row, so it comes first.
      await this.transactionRepository.insert(trx, transaction);
      const logSeq = await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: TRANSACTION_LOG_TYPE.CREATED,
        transactionId: transaction.id,
        payload: {
          reference: transaction.reference,
          metadata: transaction.metadata.entries,
          postedAt: transaction.postedAt.toISOString(),
          postings: toPostingsPayload(transaction.postings),
        },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        logSeq,
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        eventType: 'ledger.transaction.created',
        payload: {
          transactionId: transaction.id,
          ledgerId: ledger.id,
          organizationId: transaction.organizationId,
          reference: transaction.reference,
          metadata: transaction.metadata.entries,
          postedAt: transaction.postedAt.toISOString(),
          createdAt: transaction.createdAt.toISOString(),
          postings: toPostingsPayload(transaction.postings),
        },
      });

      return { transaction, replayed: false };
    });
  }

  /**
   * Loads the transaction that a key points to. The key and the transaction are
   * saved together. `createdMetadata` is the metadata of this request, which is
   * the metadata of the first call, because the hash of the two matched.
   */
  private async findReplayed(
    trx: TenantTransaction,
    ledgerId: string,
    transactionId: string,
    createdMetadata: Metadata,
  ): Promise<Transaction> {
    const transaction = await this.transactionRepository.findById(trx, ledgerId, transactionId);
    if (transaction === null) {
      // The database refuses a key without its transaction (a foreign key), so
      // this is a bug. It must not be a 404: the ledger did nothing wrong.
      throw new Error(`Idempotency key points to a missing transaction (${transactionId})`);
    }
    // The answer of a repeat is the answer of the first call: the transaction
    // as it was saved, even if it was reverted or got other metadata after that.
    return transaction.asCreated(createdMetadata);
  }
}

function toPosting(input: IPostingInput): Posting {
  return Posting.of(
    AccountAddress.of(input.source),
    AccountAddress.of(input.destination),
    Money.of(AssetCode.of(input.asset), input.amount),
  );
}
