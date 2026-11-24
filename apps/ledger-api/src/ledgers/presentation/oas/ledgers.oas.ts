import { errorResponse, invalidRequest } from '../../../core/errors/errors.oas.js';
import { LOCATION_HEADER } from '../../../core/openapi/http.oas.js';
import { parameterRef, headerRef } from '../../../core/openapi/openapi-document.builder.js';
import type {
  IOpenApiModule,
  IOpenApiParameter,
  IOpenApiTag,
} from '../../../core/openapi/openapi.type.js';
import {
  PAGINATION_PARAMETERS,
  PAGINATION_VALIDATION_ERROR,
} from '../../../core/openapi/pagination.oas.js';
import { ORGANIZATION_ID_PARAMETER } from '../../../core/tenant/tenant.oas.js';
import { saveMetadataSchema } from '../../../core/validation/metadata.dto.js';
import { createLedgerSchema } from '../dto/create-ledger.dto.js';
import { ledgerNameSchema } from '../dto/ledger-name.dto.js';
import { ledgerPageResponseSchema, ledgerResponseSchema } from '../dto/ledger-response.dto.js';

export const LEDGERS_TAG: IOpenApiTag = {
  name: 'Ledgers',
  description:
    'A ledger is a separate book of accounts and transactions, with its own history. ' +
    'An organization can have many ledgers.',
};

const organizationId = parameterRef(ORGANIZATION_ID_PARAMETER);

/** The `{ledgerName}` of every URL under a ledger. The ledgers routes call it `{name}`, see below. */
export const LEDGER_NAME_PARAMETER: IOpenApiParameter = {
  in: 'path',
  name: 'ledgerName',
  description: 'The name of the ledger.',
  schema: ledgerNameSchema,
};

const nameParameter: IOpenApiParameter = { ...LEDGER_NAME_PARAMETER, name: 'name' };

const NOT_FOUND = { LEDGER_NOT_FOUND: 'no such ledger in this organization.' };
const METADATA_TOO_BIG = {
  METADATA_LIMIT_EXCEEDED:
    'the ledger would have too many keys, or a key, a value or the total would be too big.',
};

export const ledgersOpenApi: IOpenApiModule = {
  sharedSchemas: { LedgerName: ledgerNameSchema },
  requestSchemas: { CreateLedgerRequest: createLedgerSchema },
  responseSchemas: { Ledger: ledgerResponseSchema, LedgerPage: ledgerPageResponseSchema },
  operations: [
    {
      method: 'post',
      path: '/ledgers',
      operationId: 'createLedger',
      tag: LEDGERS_TAG.name,
      summary: 'Create a ledger',
      description:
        'Creates a ledger in the organization of the `X-Organization-Id` header. ' +
        'The name is unique in the organization, and a name is never free again: ' +
        'even after the ledger is deleted, it cannot be used a second time.',
      parameters: [organizationId],
      requestBody: { required: true, schema: createLedgerSchema },
      responses: {
        201: {
          description: 'The ledger was created.',
          headers: { [LOCATION_HEADER]: headerRef(LOCATION_HEADER) },
          schema: ledgerResponseSchema,
        },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the shape is wrong. `details` says which fields.',
          INVALID_LEDGER_NAME: 'the name is reserved.',
          INVALID_METADATA: 'the metadata is not valid.',
          ...METADATA_TOO_BIG,
          ...invalidRequest(true),
        }),
        409: errorResponse('The name is taken.', {
          LEDGER_ALREADY_EXISTS: 'the organization already uses this name.',
        }),
      },
    },
    {
      method: 'get',
      path: '/ledgers',
      operationId: 'listLedgers',
      tag: LEDGERS_TAG.name,
      summary: 'List ledgers',
      description:
        'Lists the ledgers of the organization of the `X-Organization-Id` header, sorted by ' +
        'name, one page at a time. A deleted ledger is not listed.\n\n' +
        'To read all pages, call again with `cursor` set to the `next` of the last response, ' +
        'until `hasMore` is `false`.',
      parameters: [organizationId, ...PAGINATION_PARAMETERS],
      responses: {
        200: {
          description: 'One page. It is empty when the organization has no ledgers.',
          schema: ledgerPageResponseSchema,
        },
        400: errorResponse('The request is wrong.', {
          VALIDATION: PAGINATION_VALIDATION_ERROR,
          ...invalidRequest(false),
        }),
      },
    },
    {
      method: 'get',
      path: '/ledgers/{name}',
      operationId: 'getLedger',
      tag: LEDGERS_TAG.name,
      summary: 'Get a ledger',
      description: 'Gets a ledger of the organization of the `X-Organization-Id` header, by name.',
      parameters: [organizationId, nameParameter],
      responses: {
        200: { description: 'The ledger.', schema: ledgerResponseSchema },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the name has a wrong shape.',
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger.', NOT_FOUND),
      },
    },
    {
      method: 'delete',
      path: '/ledgers/{name}',
      operationId: 'deleteLedger',
      tag: LEDGERS_TAG.name,
      summary: 'Delete a ledger',
      description:
        'Deletes a ledger of the organization of the `X-Organization-Id` header.\n\n' +
        'The ledger is archived, not erased: its journal stays in storage. From now on every ' +
        'request for it answers `404 LEDGER_NOT_FOUND`, it is left out of the list, and its ' +
        'name cannot be used again (creating it gives `409 LEDGER_ALREADY_EXISTS`). ' +
        'A ledger that still holds money can be deleted. **There is no way to undo it.**',
      parameters: [organizationId, nameParameter],
      responses: {
        204: { description: 'The ledger is deleted.' },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the name has a wrong shape.',
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger.', {
          LEDGER_NOT_FOUND: 'no such ledger in this organization, or it was already deleted.',
        }),
      },
    },
    {
      method: 'post',
      path: '/ledgers/{name}/metadata',
      operationId: 'saveLedgerMetadata',
      tag: LEDGERS_TAG.name,
      summary: 'Add metadata to a ledger',
      description:
        'Adds metadata entries to a ledger of the organization of the `X-Organization-Id` ' +
        'header. The body is a plain object, like `{ "env": "prod" }`. A key that is already ' +
        'there gets the new value, and the other keys stay as they are.\n\n' +
        'It is safe to repeat: the same body gives the same result.',
      parameters: [organizationId, nameParameter],
      requestBody: { required: true, schema: saveMetadataSchema },
      responses: {
        204: { description: 'The metadata is saved (or was already like this).' },
        400: errorResponse('The request is wrong.', {
          VALIDATION:
            'the name has a wrong shape, the body is not an object of strings, a key is empty, or there is no key at all.',
          ...METADATA_TOO_BIG,
          ...invalidRequest(true),
        }),
        404: errorResponse('There is no such ledger.', NOT_FOUND),
      },
    },
    {
      method: 'delete',
      path: '/ledgers/{name}/metadata/{key}',
      operationId: 'deleteLedgerMetadata',
      tag: LEDGERS_TAG.name,
      summary: 'Remove a metadata key from a ledger',
      description:
        'Removes one metadata key from a ledger of the organization of the `X-Organization-Id` ' +
        'header.\n\nIt is safe to repeat: a key that is not there is not an error.',
      parameters: [organizationId, nameParameter, parameterRef('MetadataKey')],
      responses: {
        204: { description: 'The key is gone (or was never there).' },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the name has a wrong shape.',
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger.', NOT_FOUND),
      },
    },
  ],
};
