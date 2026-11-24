import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AccountExceptionFilter } from '../../../accounts/presentation/filters/account-exception.filter.js';
import { OrganizationId } from '../../../core/tenant/organization-id.decorator.js';
import { TenantGuard } from '../../../core/tenant/tenant.guard.js';
import {
  metadataKeySchema,
  saveMetadataSchema,
  type SaveMetadataDto,
} from '../../../core/validation/metadata.dto.js';
import { IDEMPOTENT_REPLAYED_HEADER } from '../../../idempotency/presentation/constants/idempotency-header.constant.js';
import { IdempotencyKey } from '../../../idempotency/presentation/decorators/idempotency-key.decorator.js';
import { IdempotencyExceptionFilter } from '../../../idempotency/presentation/filters/idempotency-exception.filter.js';
import { LedgerExceptionFilter } from '../../../ledgers/presentation/filters/ledger-exception.filter.js';
import { ledgerNameSchema } from '../../../ledgers/presentation/dto/ledger-name.dto.js';
import { CreateTransactionUseCase } from '../../application/use-cases/create-transaction.use-case.js';
import { DeleteTransactionMetadataUseCase } from '../../application/use-cases/delete-transaction-metadata.use-case.js';
import { GetTransactionUseCase } from '../../application/use-cases/get-transaction.use-case.js';
import { ListTransactionsUseCase } from '../../application/use-cases/list-transactions.use-case.js';
import { RevertTransactionUseCase } from '../../application/use-cases/revert-transaction.use-case.js';
import { SaveTransactionMetadataUseCase } from '../../application/use-cases/save-transaction-metadata.use-case.js';
import {
  createTransactionSchema,
  type CreateTransactionDto,
} from '../dto/create-transaction.dto.js';
import {
  listTransactionsQuerySchema,
  type ListTransactionsQueryDto,
} from '../dto/list-transactions-query.dto.js';
import {
  revertTransactionSchema,
  type RevertTransactionDto,
} from '../dto/revert-transaction.dto.js';
import { transactionIdSchema } from '../dto/transaction-id.dto.js';
import {
  toTransactionPageResponseDto,
  toTransactionResponseDto,
  type TransactionPageResponseDto,
  type TransactionResponseDto,
} from '../dto/transaction-response.dto.js';
import { TransactionExceptionFilter } from '../filters/transaction-exception.filter.js';

const LEDGERS_PATH = 'ledgers';
const TRANSACTIONS_PATH = 'transactions';
const REVERT_PATH = 'revert';
const METADATA_PATH = 'metadata';

/**
 * HTTP entry of the transactions feature. It only reads the request, calls a
 * use case and shapes the response. Rules live in the domain, and the domain
 * errors become HTTP errors in `TransactionExceptionFilter`.
 *
 * A transaction belongs to a ledger, so its URL is under the ledger. The
 * ledger errors (`LEDGER_NOT_FOUND`), the account errors
 * (`INSUFFICIENT_FUNDS`) and the idempotency errors (`IDEMPOTENCY_KEY_REUSED`)
 * are turned into HTTP errors by the filters of their own features.
 *
 * `TenantGuard` runs first, so a bad `X-Organization-Id` header is refused
 * before the body or the URL is looked at.
 */
@Controller(`${LEDGERS_PATH}/:ledgerName/${TRANSACTIONS_PATH}`)
@UseGuards(TenantGuard)
@UseFilters(
  LedgerExceptionFilter,
  AccountExceptionFilter,
  IdempotencyExceptionFilter,
  TransactionExceptionFilter,
)
export class TransactionsController {
  constructor(
    private readonly createTransaction: CreateTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
    private readonly listTransactions: ListTransactionsUseCase,
    private readonly revertTransaction: RevertTransactionUseCase,
    private readonly saveTransactionMetadata: SaveTransactionMetadataUseCase,
    private readonly deleteTransactionMetadata: DeleteTransactionMetadataUseCase,
  ) {}

  /**
   * Creates a transaction in a ledger of the organization of the
   * `X-Organization-Id` header: moves money between accounts, all postings or
   * none. Accounts that do not exist yet are created. Only `world` may go
   * below zero.
   *
   * Amounts are strings of digits (`"1050"`), in the smallest unit of the
   * asset, in the request and in the response.
   *
   * Postings are applied in order, and each one is checked when it is applied.
   * A transaction that takes money out of an account before the money comes in
   * fails, even if the account would end above zero.
   *
   * `metadata` is an optional object of strings, like `{ "orderId": "42" }`,
   * saved with the transaction. Use ids, not personal data: the journal keeps
   * what is written. It can be edited later (see `saveMetadata`).
   *
   * **Safe to repeat.** Send an `Idempotency-Key` header (1 to 255 printable
   * ASCII characters) and the transaction is created once, however many times
   * the same request is sent. A repeat answers like the first call: `201`,
   * the same body and the same `Location`, plus the header
   * `Idempotent-Replayed: true`. The metadata is part of the request, and a
   * repeat answers with the metadata of the first call, even if it was edited
   * since. A key is remembered for 24 hours, for one ledger. A request that failed leaves no key, so it can be sent again with
   * the same key. Without the header, every request creates a transaction.
   *
   * - `201`: the transaction was created (or, with `Idempotent-Replayed: true`,
   *   it was created by an earlier call with the same key). The `Location`
   *   header is its URL.
   * - `400`: `VALIDATION` (bad shape: a missing field, an unknown field, a bad
   *   address, asset code or amount, no postings or more than 100, bad
   *   metadata, or a bad `Idempotency-Key`), `INVALID_POSTING` (a posting has
   *   the same source and destination), `INVALID_TRANSACTION`, or
   *   `METADATA_LIMIT_EXCEEDED` (a key, a value or the metadata is too big, or
   *   it has too many keys).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization).
   * - `409`: `TRANSACTION_REFERENCE_ALREADY_EXISTS` (the ledger already has a
   *   transaction with this reference).
   * - `422`: `INSUFFICIENT_FUNDS` (an account does not have enough money) or
   *   `IDEMPOTENCY_KEY_REUSED` (the key was used for a different request).
   */
  @Post()
  async create(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body({ schema: createTransactionSchema }) body: CreateTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TransactionResponseDto> {
    const { transaction, replayed } = await this.createTransaction.execute({
      organizationId,
      ledgerName,
      reference: body.reference,
      postings: body.postings,
      metadata: body.metadata,
      idempotencyKey,
    });
    // The ledger name passed the name pattern, and the id is made by the ledger,
    // so both are safe in a URL.
    response.location(`/${LEDGERS_PATH}/${ledgerName}/${TRANSACTIONS_PATH}/${transaction.id}`);
    if (replayed) {
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return toTransactionResponseDto(transaction);
  }

  /**
   * Lists the transactions of a ledger of the organization of the
   * `X-Organization-Id` header, one page at a time, newest first (by
   * `postedAt`, and by `id` when two have the same `postedAt`). Each one has
   * the same shape as the response of the create call.
   *
   * To read all pages, call again with `cursor` set to the `next` of the last
   * response, until `hasMore` is `false`. New transactions are always newer,
   * so they never move the pages that follow a cursor.
   *
   * - `200`: one page. It is empty when the ledger has no transactions.
   * - `400`: `VALIDATION` (the ledger name has a wrong shape, `pageSize` is
   *   not a whole number from 1 to 100, the `cursor` is not one we gave, or a
   *   query parameter is unknown).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization).
   */
  @Get()
  async list(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Query({ schema: listTransactionsQuerySchema }) query: ListTransactionsQueryDto,
  ): Promise<TransactionPageResponseDto> {
    const page = await this.listTransactions.execute({
      organizationId,
      ledgerName,
      pageSize: query.pageSize,
      after: query.cursor,
    });
    return toTransactionPageResponseDto(page);
  }

  /**
   * Gets a transaction of a ledger of the organization of the
   * `X-Organization-Id` header, by its id. The response has the same shape as
   * the one of the create call.
   *
   * - `200`: the transaction.
   * - `400`: `VALIDATION` (the ledger name or the id has a wrong shape).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization) or
   *   `TRANSACTION_NOT_FOUND` (no such transaction in this ledger).
   */
  @Get(':transactionId')
  async get(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Param('transactionId', { schema: transactionIdSchema }) transactionId: string,
  ): Promise<TransactionResponseDto> {
    const transaction = await this.getTransaction.execute({
      organizationId,
      ledgerName,
      transactionId,
    });
    return toTransactionResponseDto(transaction);
  }

  /**
   * Reverts a transaction of a ledger of the organization of the
   * `X-Organization-Id` header: makes a new transaction that moves the same
   * money back (every posting goes the other way, in the opposite order), and
   * marks the old one as reverted. The old transaction is not changed
   * otherwise.
   *
   * The body is optional. It can have `metadata`, an object of strings like
   * `{ "reason": "duplicate charge" }`, saved with the NEW transaction. Use
   * ids, not personal data: the journal keeps what is written. The metadata of
   * the old transaction is not copied.
   *
   * The response is the NEW transaction, in the same shape as the one of the
   * create call. Its `Location` header is its URL. It has no reference and
   * `postedAt` is the time of the revert. The old transaction now shows
   * `revertedAt` and `revertedByTransactionId`.
   *
   * The money must still be there. If an account spent it after the original
   * transaction, the revert fails with `INSUFFICIENT_FUNDS`, and nothing is
   * forced: an account never goes below zero (only `world` may).
   *
   * **Safe to repeat.** Send an `Idempotency-Key` header, like on create. A
   * repeat answers like the first call: `201`, the same body and `Location`,
   * plus `Idempotent-Replayed: true`. The metadata is part of the request, and
   * a repeat answers with the metadata of the first call, even if it was
   * edited since. Without a key, a second revert of the same transaction is
   * refused with `TRANSACTION_ALREADY_REVERTED`.
   *
   * - `201`: the transaction was reverted (or, with `Idempotent-Replayed:
   *   true`, it was reverted by an earlier call with the same key).
   * - `400`: `VALIDATION` (the ledger name or the id has a wrong shape, the
   *   body has an unknown field or bad metadata, or a bad `Idempotency-Key`)
   *   or `METADATA_LIMIT_EXCEEDED` (a key, a value or the metadata is too big,
   *   or it has too many keys).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization) or
   *   `TRANSACTION_NOT_FOUND` (no such transaction in this ledger).
   * - `409`: `TRANSACTION_ALREADY_REVERTED`.
   * - `422`: `INSUFFICIENT_FUNDS` (an account does not have the money to give
   *   back) or `IDEMPOTENCY_KEY_REUSED` (the key was used for a different
   *   request).
   */
  @Post(`:transactionId/${REVERT_PATH}`)
  async revert(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Param('transactionId', { schema: transactionIdSchema }) transactionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body({ schema: revertTransactionSchema }) body: RevertTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TransactionResponseDto> {
    const { transaction, replayed } = await this.revertTransaction.execute({
      organizationId,
      ledgerName,
      transactionId,
      metadata: body.metadata,
      idempotencyKey,
    });
    // The location is the NEW transaction, not the one in the URL.
    response.location(`/${LEDGERS_PATH}/${ledgerName}/${TRANSACTIONS_PATH}/${transaction.id}`);
    if (replayed) {
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return toTransactionResponseDto(transaction);
  }

  /**
   * Adds metadata entries to a transaction of a ledger of the organization of
   * the `X-Organization-Id` header. The body is a plain object, like
   * `{ "orderId": "42" }`. A key that is already there gets the new value, and
   * the other keys stay as they are. The postings never change. It also works
   * on a reverted transaction.
   *
   * It is safe to repeat: the same body gives the same result. Every real
   * change leaves an entry in the journal, and a repeat that changes nothing
   * leaves none.
   *
   * - `204`: the metadata is saved (or was already like this).
   * - `400`: `VALIDATION` (the ledger name or the id has a wrong shape, the
   *   body is not an object of strings, a key is empty, or there is no key at
   *   all) or `METADATA_LIMIT_EXCEEDED` (the transaction would have too many
   *   keys, or a key, a value or the total would be too big).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization) or
   *   `TRANSACTION_NOT_FOUND` (no such transaction in this ledger).
   */
  @Post(`:transactionId/${METADATA_PATH}`)
  @HttpCode(HttpStatus.NO_CONTENT)
  async saveMetadata(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Param('transactionId', { schema: transactionIdSchema }) transactionId: string,
    @Body({ schema: saveMetadataSchema }) metadata: SaveMetadataDto,
  ): Promise<void> {
    await this.saveTransactionMetadata.execute({
      organizationId,
      ledgerName,
      transactionId,
      metadata,
    });
  }

  /**
   * Removes one metadata key from a transaction of a ledger of the
   * organization of the `X-Organization-Id` header.
   *
   * It is safe to repeat: a key that is not there is not an error.
   *
   * - `204`: the key is gone (or was never there).
   * - `400`: `VALIDATION` (the ledger name or the id has a wrong shape).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization) or
   *   `TRANSACTION_NOT_FOUND` (no such transaction in this ledger).
   */
  @Delete(`:transactionId/${METADATA_PATH}/:key`)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMetadata(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Param('transactionId', { schema: transactionIdSchema }) transactionId: string,
    @Param('key', { schema: metadataKeySchema }) key: string,
  ): Promise<void> {
    await this.deleteTransactionMetadata.execute({
      organizationId,
      ledgerName,
      transactionId,
      key,
    });
  }
}
