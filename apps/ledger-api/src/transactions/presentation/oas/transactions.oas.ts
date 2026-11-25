import { MAX_MONEY_AMOUNT } from '@ledger/domain';
import { errorResponse, invalidRequest } from '../../../core/errors/errors.oas.js';
import { LOCATION_HEADER } from '../../../core/openapi/http.oas.js';
import { headerRef, parameterRef } from '../../../core/openapi/openapi-document.builder.js';
import type {
  IOpenApiModule,
  IOpenApiParameter,
  IOpenApiResponse,
  IOpenApiTag,
} from '../../../core/openapi/openapi.type.js';
import {
  PAGINATION_PARAMETERS,
  PAGINATION_VALIDATION_ERROR,
} from '../../../core/openapi/pagination.oas.js';
import { ORGANIZATION_ID_PARAMETER } from '../../../core/tenant/tenant.oas.js';
import { saveMetadataSchema } from '../../../core/validation/metadata.dto.js';
import {
  IDEMPOTENCY_KEY_PARAMETER,
  IDEMPOTENT_REPLAYED_HEADER_REF,
} from '../../../idempotency/presentation/oas/idempotency.oas.js';
import { LEDGER_NAME_PARAMETER } from '../../../ledgers/presentation/oas/ledgers.oas.js';
import { TRANSACTION_MAX_POSTINGS } from '../../domain/constants/transaction-limits.constant.js';
import { createTransactionSchema } from '../dto/create-transaction.dto.js';
import { revertTransactionSchema } from '../dto/revert-transaction.dto.js';
import { transactionIdSchema } from '../dto/transaction-id.dto.js';
import {
  postingResponseSchema,
  transactionPageResponseSchema,
  transactionResponseSchema,
} from '../dto/transaction-response.dto.js';

export const TRANSACTIONS_TAG: IOpenApiTag = {
  name: 'Transactions',
  description:
    'A transaction moves money between accounts, all postings or none. ' +
    'It never changes after it is made, except that it can be reverted and its metadata edited.',
};

const organizationId = parameterRef(ORGANIZATION_ID_PARAMETER);

const transactionIdParameter: IOpenApiParameter = {
  in: 'path',
  name: 'transactionId',
  description: 'The id of the transaction.',
  schema: transactionIdSchema,
};

const LEDGER_NOT_FOUND = { LEDGER_NOT_FOUND: 'no such ledger in this organization.' };
const TRANSACTION_NOT_FOUND = { TRANSACTION_NOT_FOUND: 'no such transaction in this ledger.' };
const METADATA_TOO_BIG = {
  METADATA_LIMIT_EXCEEDED: 'a key, a value or the metadata is too big, or it has too many keys.',
};
const AMOUNT_OUT_OF_RANGE = {
  MONEY_AMOUNT_OUT_OF_RANGE: `an account would hold more than the biggest amount, which has ${MAX_MONEY_AMOUNT.toString().length} digits.`,
};
const IDEMPOTENCY_KEY_REUSED = {
  IDEMPOTENCY_KEY_REUSED: 'the `Idempotency-Key` was used for a different request.',
};

/** The 201 of create and revert: the new transaction, its URL, and the replay marker. */
function createdTransaction(description: string): IOpenApiResponse {
  return {
    description,
    headers: {
      [LOCATION_HEADER]: headerRef(LOCATION_HEADER),
      'Idempotent-Replayed': IDEMPOTENT_REPLAYED_HEADER_REF,
    },
    schema: transactionResponseSchema,
  };
}

export const transactionsOpenApi: IOpenApiModule = {
  sharedSchemas: { TransactionId: transactionIdSchema },
  requestSchemas: {
    CreateTransactionRequest: createTransactionSchema,
    RevertTransactionRequest: revertTransactionSchema,
  },
  responseSchemas: {
    Posting: postingResponseSchema,
    Transaction: transactionResponseSchema,
    TransactionPage: transactionPageResponseSchema,
  },
  operations: [
    {
      method: 'post',
      path: '/ledgers/{ledgerName}/transactions',
      operationId: 'createTransaction',
      tag: TRANSACTIONS_TAG.name,
      summary: 'Create a transaction',
      description:
        'Creates a transaction in a ledger of the organization of the `X-Organization-Id` ' +
        'header: moves money between accounts, all postings or none. Accounts that do not ' +
        'exist yet are created. Only `world` may go below zero.\n\n' +
        'Postings are applied in order, and each one is checked when it is applied. A ' +
        'transaction that takes money out of an account before the money comes in fails, ' +
        'even if the account would end above zero.\n\n' +
        '`metadata` is saved with the transaction and can be edited later. It is part of the ' +
        'request: a repeat with the same `Idempotency-Key` answers with the metadata of the ' +
        'first call, even if it was edited since.',
      parameters: [organizationId, LEDGER_NAME_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
      requestBody: { required: true, schema: createTransactionSchema },
      responses: {
        201: createdTransaction(
          'The transaction was created. With `Idempotent-Replayed: true`, it was created by an ' +
            'earlier call with the same `Idempotency-Key`, and nothing ran this time.',
        ),
        400: errorResponse('The request is wrong.', {
          VALIDATION: `the shape is wrong: a missing or unknown field, a bad address, asset code or amount, no postings or more than ${TRANSACTION_MAX_POSTINGS}, bad metadata, or a bad \`Idempotency-Key\`.`,
          INVALID_POSTING: 'a posting has the same source and destination.',
          INVALID_TRANSACTION:
            'the transaction has no postings or too many, or its reference has a wrong length.',
          ...AMOUNT_OUT_OF_RANGE,
          ...METADATA_TOO_BIG,
          ...invalidRequest(true),
        }),
        404: errorResponse('There is no such ledger.', LEDGER_NOT_FOUND),
        409: errorResponse('The reference is taken.', {
          TRANSACTION_REFERENCE_ALREADY_EXISTS:
            'the ledger already has a transaction with this reference.',
        }),
        422: errorResponse('The request is well formed, but it cannot be done.', {
          INSUFFICIENT_FUNDS: 'an account does not have enough money.',
          ...IDEMPOTENCY_KEY_REUSED,
        }),
      },
    },
    {
      method: 'get',
      path: '/ledgers/{ledgerName}/transactions',
      operationId: 'listTransactions',
      tag: TRANSACTIONS_TAG.name,
      summary: 'List transactions',
      description:
        'Lists the transactions of a ledger of the organization of the `X-Organization-Id` ' +
        'header, one page at a time, newest first (by `postedAt`, and by `id` when two have the ' +
        'same `postedAt`). Each one has the same shape as the response of the create call.\n\n' +
        'To read all pages, call again with `cursor` set to the `next` of the last response, ' +
        'until `hasMore` is `false`. A transaction that was already there when you started is ' +
        'never skipped or shown twice. A transaction that is created while you read can show up ' +
        'on a page you have not read yet, or be missed by this pass, because it gets its ' +
        '`postedAt` when its request runs, not when it is saved. Start again from the first ' +
        'page to see it.',
      parameters: [organizationId, LEDGER_NAME_PARAMETER, ...PAGINATION_PARAMETERS],
      responses: {
        200: {
          description: 'One page. It is empty when the ledger has no transactions.',
          schema: transactionPageResponseSchema,
        },
        400: errorResponse('The request is wrong.', {
          VALIDATION: `the ledger name has a wrong shape, ${PAGINATION_VALIDATION_ERROR}`,
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger.', LEDGER_NOT_FOUND),
      },
    },
    {
      method: 'get',
      path: '/ledgers/{ledgerName}/transactions/{transactionId}',
      operationId: 'getTransaction',
      tag: TRANSACTIONS_TAG.name,
      summary: 'Get a transaction',
      description:
        'Gets a transaction of a ledger of the organization of the `X-Organization-Id` header, ' +
        'by its id.',
      parameters: [organizationId, LEDGER_NAME_PARAMETER, transactionIdParameter],
      responses: {
        200: { description: 'The transaction.', schema: transactionResponseSchema },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the ledger name or the id has a wrong shape.',
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger or transaction.', {
          ...LEDGER_NOT_FOUND,
          ...TRANSACTION_NOT_FOUND,
        }),
      },
    },
    {
      method: 'post',
      path: '/ledgers/{ledgerName}/transactions/{transactionId}/revert',
      operationId: 'revertTransaction',
      tag: TRANSACTIONS_TAG.name,
      summary: 'Revert a transaction',
      description:
        'Reverts a transaction of a ledger of the organization of the `X-Organization-Id` ' +
        'header: makes a new transaction that moves the same money back (every posting goes ' +
        'the other way, in the opposite order), and marks the old one as reverted. The old ' +
        'transaction is not changed otherwise.\n\n' +
        'The body is optional. `metadata` is saved with the NEW transaction (a `reason`, for ' +
        'example). The metadata of the old transaction is not copied.\n\n' +
        'The response is the NEW transaction. Its `Location` header is its URL. It has no ' +
        'reference, and `postedAt` is the time of the revert. The old transaction now shows ' +
        '`revertedAt` and `revertedByTransactionId`.\n\n' +
        'The money must still be there. If an account spent it after the original ' +
        'transaction, the revert fails with `INSUFFICIENT_FUNDS`, and nothing is forced: an ' +
        'account never goes below zero (only `world` may).\n\n' +
        'Without an `Idempotency-Key`, a second revert of the same transaction is refused ' +
        'with `TRANSACTION_ALREADY_REVERTED`.',
      parameters: [
        organizationId,
        LEDGER_NAME_PARAMETER,
        transactionIdParameter,
        IDEMPOTENCY_KEY_PARAMETER,
      ],
      requestBody: { required: false, schema: revertTransactionSchema },
      responses: {
        201: createdTransaction(
          'The transaction was reverted. With `Idempotent-Replayed: true`, it was reverted by an ' +
            'earlier call with the same `Idempotency-Key`, and nothing ran this time. ' +
            'The body is the new transaction.',
        ),
        400: errorResponse('The request is wrong.', {
          VALIDATION:
            'the ledger name or the id has a wrong shape, the body has an unknown field or bad metadata, or the `Idempotency-Key` is bad.',
          ...AMOUNT_OUT_OF_RANGE,
          ...METADATA_TOO_BIG,
          ...invalidRequest(true),
        }),
        404: errorResponse('There is no such ledger or transaction.', {
          ...LEDGER_NOT_FOUND,
          ...TRANSACTION_NOT_FOUND,
        }),
        409: errorResponse('The transaction is already reverted.', {
          TRANSACTION_ALREADY_REVERTED: 'the transaction was reverted before.',
        }),
        422: errorResponse('The request is well formed, but it cannot be done.', {
          INSUFFICIENT_FUNDS: 'an account does not have the money to give back.',
          ...IDEMPOTENCY_KEY_REUSED,
        }),
      },
    },
    {
      method: 'post',
      path: '/ledgers/{ledgerName}/transactions/{transactionId}/metadata',
      operationId: 'saveTransactionMetadata',
      tag: TRANSACTIONS_TAG.name,
      summary: 'Add metadata to a transaction',
      description:
        'Adds metadata entries to a transaction of a ledger of the organization of the ' +
        '`X-Organization-Id` header. The body is a plain object, like `{ "orderId": "42" }`. ' +
        'A key that is already there gets the new value, and the other keys stay as they are. ' +
        'The postings never change. It also works on a reverted transaction.\n\n' +
        'It is safe to repeat: the same body gives the same result. Every real change leaves ' +
        'an entry in the journal, and a repeat that changes nothing leaves none.',
      parameters: [organizationId, LEDGER_NAME_PARAMETER, transactionIdParameter],
      requestBody: { required: true, schema: saveMetadataSchema },
      responses: {
        204: { description: 'The metadata is saved (or was already like this).' },
        400: errorResponse('The request is wrong.', {
          VALIDATION:
            'the ledger name or the id has a wrong shape, the body is not an object of strings, a key is empty, or there is no key at all.',
          METADATA_LIMIT_EXCEEDED:
            'the transaction would have too many keys, or a key, a value or the total would be too big.',
          ...invalidRequest(true),
        }),
        404: errorResponse('There is no such ledger or transaction.', {
          ...LEDGER_NOT_FOUND,
          ...TRANSACTION_NOT_FOUND,
        }),
      },
    },
    {
      method: 'delete',
      path: '/ledgers/{ledgerName}/transactions/{transactionId}/metadata/{key}',
      operationId: 'deleteTransactionMetadata',
      tag: TRANSACTIONS_TAG.name,
      summary: 'Remove a metadata key from a transaction',
      description:
        'Removes one metadata key from a transaction of a ledger of the organization of the ' +
        '`X-Organization-Id` header.\n\nIt is safe to repeat: a key that is not there is not ' +
        'an error.',
      parameters: [
        organizationId,
        LEDGER_NAME_PARAMETER,
        transactionIdParameter,
        parameterRef('MetadataKey'),
      ],
      responses: {
        204: { description: 'The key is gone (or was never there).' },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the ledger name or the id has a wrong shape.',
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger or transaction.', {
          ...LEDGER_NOT_FOUND,
          ...TRANSACTION_NOT_FOUND,
        }),
      },
    },
  ],
};
