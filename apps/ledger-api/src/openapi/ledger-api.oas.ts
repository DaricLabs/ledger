import { errorsOpenApi } from '../core/errors/errors.oas.js';
import { healthOpenApi, HEALTH_TAG } from '../core/health/health.oas.js';
import { buildOpenApiDocument } from '../core/openapi/openapi-document.builder.js';
import type { IOpenApiDocument, IOpenApiModule } from '../core/openapi/openapi.type.js';
import { httpOpenApi } from '../core/openapi/http.oas.js';
import { paginationOpenApi } from '../core/openapi/pagination.oas.js';
import { tenantOpenApi } from '../core/tenant/tenant.oas.js';
import { metadataOpenApi } from '../core/validation/metadata.oas.js';
import { accountsOpenApi, ACCOUNTS_TAG } from '../accounts/presentation/oas/accounts.oas.js';
import { idempotencyOpenApi } from '../idempotency/presentation/oas/idempotency.oas.js';
import { ledgersOpenApi, LEDGERS_TAG } from '../ledgers/presentation/oas/ledgers.oas.js';
import {
  transactionsOpenApi,
  TRANSACTIONS_TAG,
} from '../transactions/presentation/oas/transactions.oas.js';

/**
 * Every part of the API description, in the order it shows in the document.
 * A new feature adds its own module here, and nowhere else.
 */
export const OPENAPI_MODULES: IOpenApiModule[] = [
  httpOpenApi,
  errorsOpenApi,
  tenantOpenApi,
  paginationOpenApi,
  metadataOpenApi,
  idempotencyOpenApi,
  ledgersOpenApi,
  transactionsOpenApi,
  accountsOpenApi,
  healthOpenApi,
];

/** Builds the OpenAPI 3.1 description of the ledger API. `openapi.json` is this, written to disk. */
export function buildLedgerOpenApiDocument(version: string): IOpenApiDocument {
  return buildOpenApiDocument({
    info: {
      title: 'Daric Ledger API',
      version,
      description:
        'A double-entry ledger: ledgers, accounts and transactions that move money between ' +
        'accounts, with an append-only journal.\n\n' +
        'Every request, except `/health`, carries the `X-Organization-Id` header. Posting ' +
        'amounts are strings of digits in the smallest unit of the asset. Balance amounts use ' +
        'the same format and have a leading `-` when below zero.',
    },
    tags: [LEDGERS_TAG, TRANSACTIONS_TAG, ACCOUNTS_TAG, HEALTH_TAG],
    modules: OPENAPI_MODULES,
  });
}

/** The text of `openapi.json`: the document as JSON, two spaces, one newline at the end. */
export function serializeOpenApiDocument(document: IOpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
