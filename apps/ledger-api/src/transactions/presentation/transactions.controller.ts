import { Body, Controller, Get, Param, Post, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OrganizationId } from '../../core/tenant/organization-id.decorator.js';
import { TenantGuard } from '../../core/tenant/tenant.guard.js';
import { LedgerExceptionFilter } from '../../ledgers/presentation/ledger-exception.filter.js';
import { ledgerNameSchema } from '../../ledgers/presentation/dto/ledger-name.dto.js';
import { CreateTransactionUseCase } from '../application/use-cases/create-transaction.use-case.js';
import { GetTransactionUseCase } from '../application/use-cases/get-transaction.use-case.js';
import {
  createTransactionSchema,
  type CreateTransactionDto,
} from './dto/create-transaction.dto.js';
import { transactionIdSchema } from './dto/transaction-id.dto.js';
import {
  toTransactionResponseDto,
  type TransactionResponseDto,
} from './dto/transaction-response.dto.js';
import { TransactionExceptionFilter } from './transaction-exception.filter.js';

const LEDGERS_PATH = 'ledgers';
const TRANSACTIONS_PATH = 'transactions';

/**
 * HTTP entry of the transactions feature. It only reads the request, calls a
 * use case and shapes the response. Rules live in the domain, and the domain
 * errors become HTTP errors in `TransactionExceptionFilter`.
 *
 * A transaction belongs to a ledger, so its URL is under the ledger. The
 * ledger errors (`LEDGER_NOT_FOUND`) are turned into HTTP errors by the
 * ledgers feature's own filter.
 *
 * `TenantGuard` runs first, so a bad `X-Organization-Id` header is refused
 * before the body or the URL is looked at.
 */
@Controller(`${LEDGERS_PATH}/:ledgerName/${TRANSACTIONS_PATH}`)
@UseGuards(TenantGuard)
@UseFilters(LedgerExceptionFilter, TransactionExceptionFilter)
export class TransactionsController {
  constructor(
    private readonly createTransaction: CreateTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
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
   * - `201`: the transaction was created. The `Location` header is its URL.
   * - `400`: `VALIDATION` (bad shape: a missing field, an unknown field, a bad
   *   address, asset code or amount, no postings or more than 100),
   *   `INVALID_POSTING` (a posting has the same source and destination) or
   *   `INVALID_TRANSACTION`.
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization).
   * - `409`: `TRANSACTION_REFERENCE_ALREADY_EXISTS` (the ledger already has a
   *   transaction with this reference).
   * - `422`: `INSUFFICIENT_FUNDS` (an account does not have enough money).
   */
  @Post()
  async create(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Body({ schema: createTransactionSchema }) body: CreateTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TransactionResponseDto> {
    const transaction = await this.createTransaction.execute({
      organizationId,
      ledgerName,
      reference: body.reference,
      postings: body.postings,
    });
    // The ledger name passed the name pattern, and the id is made by the ledger,
    // so both are safe in a URL.
    response.location(`/${LEDGERS_PATH}/${ledgerName}/${TRANSACTIONS_PATH}/${transaction.id}`);
    return toTransactionResponseDto(transaction);
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
}
