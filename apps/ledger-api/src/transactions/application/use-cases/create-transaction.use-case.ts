import { Inject, Injectable } from '@nestjs/common';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
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
import { LedgerNotFoundError } from '../../../ledgers/domain/ledger-not-found.error.js';
import { AccountBalance } from '../../domain/account-balance.js';
import { Posting } from '../../domain/posting.js';
import { TRANSACTION_LOG_TYPE } from '../../domain/transaction-log-type.js';
import { Transaction } from '../../domain/transaction.entity.js';
import { toPostingsPayload } from '../transaction-payload.js';
import {
  ACCOUNT_BALANCE_REPOSITORY,
  type IAccountBalanceRepository,
} from '../ports/account-balance-repository.port.js';
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
}

/**
 * Creates a transaction: moves money between accounts, all postings or none.
 *
 * In one tenant transaction it:
 *
 * 1. finds the ledger;
 * 2. creates the accounts and balances that do not exist yet (`world` may go
 *    below zero, every other account may not);
 * 3. locks every balance the postings touch, in one fixed order, so two
 *    transactions that share accounts wait for each other and never deadlock;
 * 4. applies the postings to the locked balances in the domain, which refuses
 *    a posting that takes more than an account has;
 * 5. saves the new balances, the transaction and its postings;
 * 6. writes the `TRANSACTION_CREATED` journal entry and the
 *    `ledger.transaction.created` outbox event.
 *
 * Either all of it is saved or none. The journal entry takes a lock on the
 * ledger until the transaction ends, so the transactions of one ledger commit
 * one after the other, in the order of their journal entries. That is why the
 * journal comes last: a transaction holds this lock for as short a time as it
 * can, and no transaction waits for a balance while it holds the lock.
 *
 * The domain checks the postings before any transaction is opened. Domain
 * errors (`InvalidPostingError`, `InvalidTransactionError`,
 * `InsufficientFundsError`, `TransactionReferenceAlreadyExistsError` and the
 * errors of the value objects of `@ledger/domain`) pass through unchanged. The
 * presentation layer turns them into HTTP responses.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 */
@Injectable()
export class CreateTransactionUseCase {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IIdGenerator,
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(ACCOUNT_BALANCE_REPOSITORY) private readonly balances: IAccountBalanceRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: ITransactionRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: ICreateTransactionInput): Promise<Transaction> {
    // Checked first, because it needs no database.
    const postings = input.postings.map(toPosting);

    return this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      const now = new Date();
      const transaction = Transaction.create({
        id: this.ids.next(),
        organizationId: input.organizationId,
        ledgerId: ledger.id,
        reference: input.reference ?? null,
        postings,
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
      await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: TRANSACTION_LOG_TYPE.CREATED,
        transactionId: transaction.id,
        payload: {
          reference: transaction.reference,
          postedAt: transaction.postedAt.toISOString(),
          postings: toPostingsPayload(transaction.postings),
        },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        eventType: 'ledger.transaction.created',
        payload: {
          transactionId: transaction.id,
          ledgerId: ledger.id,
          organizationId: transaction.organizationId,
          reference: transaction.reference,
          postedAt: transaction.postedAt.toISOString(),
          createdAt: transaction.createdAt.toISOString(),
          postings: toPostingsPayload(transaction.postings),
        },
      });

      return transaction;
    });
  }
}

function toPosting(input: IPostingInput): Posting {
  return Posting.of(
    AccountAddress.of(input.source),
    AccountAddress.of(input.destination),
    Money.of(AssetCode.of(input.asset), input.amount),
  );
}
