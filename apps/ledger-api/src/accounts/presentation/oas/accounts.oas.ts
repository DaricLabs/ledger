import { errorResponse, invalidRequest } from '../../../core/errors/errors.oas.js';
import { parameterRef } from '../../../core/openapi/openapi-document.builder.js';
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
import { LEDGER_NAME_PARAMETER } from '../../../ledgers/presentation/oas/ledgers.oas.js';
import { accountAddressSchema } from '../dto/account-address.dto.js';
import {
  accountPageResponseSchema,
  accountResponseSchema,
  balanceResponseSchema,
} from '../dto/account-response.dto.js';

export const ACCOUNTS_TAG: IOpenApiTag = {
  name: 'Accounts',
  description:
    'An account holds money in one or more assets. There are no accounts to create: an ' +
    'account exists once money has moved through it.',
};

const organizationId = parameterRef(ORGANIZATION_ID_PARAMETER);

const addressParameter: IOpenApiParameter = {
  in: 'path',
  name: 'address',
  description: 'The address of the account.',
  schema: accountAddressSchema,
};

const LEDGER_NOT_FOUND = { LEDGER_NOT_FOUND: 'no such ledger in this organization.' };
const ACCOUNT_NOT_FOUND = {
  ACCOUNT_NOT_FOUND: 'no such account in this ledger. No transaction has used this address.',
};

export const accountsOpenApi: IOpenApiModule = {
  sharedSchemas: { AccountAddress: accountAddressSchema },
  responseSchemas: {
    Balance: balanceResponseSchema,
    Account: accountResponseSchema,
    AccountPage: accountPageResponseSchema,
  },
  operations: [
    {
      method: 'get',
      path: '/ledgers/{ledgerName}/accounts',
      operationId: 'listAccounts',
      tag: ACCOUNTS_TAG.name,
      summary: 'List accounts',
      description:
        'Lists the accounts of a ledger of the organization of the `X-Organization-Id` header, ' +
        'one page at a time, sorted by address. Each one has the same shape as the response of ' +
        'the get call.\n\n' +
        'To read all pages, call again with `cursor` set to the `next` of the last response, ' +
        'until `hasMore` is `false`. The pages follow the address, so an account that is made ' +
        'while you read never moves the pages after a cursor. It shows up only if its address ' +
        'comes after the cursor.',
      parameters: [organizationId, LEDGER_NAME_PARAMETER, ...PAGINATION_PARAMETERS],
      responses: {
        200: {
          description: 'One page. It is empty when the ledger has no accounts.',
          schema: accountPageResponseSchema,
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
      path: '/ledgers/{ledgerName}/accounts/{address}',
      operationId: 'getAccount',
      tag: ACCOUNTS_TAG.name,
      summary: 'Get an account',
      description:
        'Gets an account of a ledger of the organization of the `X-Organization-Id` header, by ' +
        'its address, with what it holds in each asset.\n\n' +
        'There are no accounts to create. An account exists once money has moved through it, ' +
        'so an address that no transaction has used gives `404`.',
      parameters: [organizationId, LEDGER_NAME_PARAMETER, addressParameter],
      responses: {
        200: { description: 'The account.', schema: accountResponseSchema },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the ledger name or the address has a wrong shape.',
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger or account.', {
          ...LEDGER_NOT_FOUND,
          ...ACCOUNT_NOT_FOUND,
        }),
      },
    },
    {
      method: 'post',
      path: '/ledgers/{ledgerName}/accounts/{address}/metadata',
      operationId: 'saveAccountMetadata',
      tag: ACCOUNTS_TAG.name,
      summary: 'Add metadata to an account',
      description:
        'Adds metadata entries to an account of a ledger of the organization of the ' +
        '`X-Organization-Id` header. The body is a plain object, like ' +
        '`{ "customerId": "c_42" }`. A key that is already there gets the new value, and the ' +
        'other keys stay as they are. The balances never change.\n\n' +
        'The account must exist: an address that no transaction has used gives `404`.\n\n' +
        'It is safe to repeat: the same body gives the same result. Every real change leaves ' +
        'an entry in the journal, and a repeat that changes nothing leaves none.',
      parameters: [organizationId, LEDGER_NAME_PARAMETER, addressParameter],
      requestBody: { required: true, schema: saveMetadataSchema },
      responses: {
        204: { description: 'The metadata is saved (or was already like this).' },
        400: errorResponse('The request is wrong.', {
          VALIDATION:
            'the ledger name or the address has a wrong shape, the body is not an object of strings, a key is empty, or there is no key at all.',
          METADATA_LIMIT_EXCEEDED:
            'the account would have too many keys, or a key, a value or the total would be too big.',
          ...invalidRequest(true),
        }),
        404: errorResponse('There is no such ledger or account.', {
          ...LEDGER_NOT_FOUND,
          ...ACCOUNT_NOT_FOUND,
        }),
      },
    },
    {
      method: 'delete',
      path: '/ledgers/{ledgerName}/accounts/{address}/metadata/{key}',
      operationId: 'deleteAccountMetadata',
      tag: ACCOUNTS_TAG.name,
      summary: 'Remove a metadata key from an account',
      description:
        'Removes one metadata key from an account of a ledger of the organization of the ' +
        '`X-Organization-Id` header.\n\nIt is safe to repeat: a key that is not there is not ' +
        'an error.',
      parameters: [
        organizationId,
        LEDGER_NAME_PARAMETER,
        addressParameter,
        parameterRef('MetadataKey'),
      ],
      responses: {
        204: { description: 'The key is gone (or was never there).' },
        400: errorResponse('The request is wrong.', {
          VALIDATION: 'the ledger name or the address has a wrong shape.',
          ...invalidRequest(false),
        }),
        404: errorResponse('There is no such ledger or account.', {
          ...LEDGER_NOT_FOUND,
          ...ACCOUNT_NOT_FOUND,
        }),
      },
    },
  ],
};
