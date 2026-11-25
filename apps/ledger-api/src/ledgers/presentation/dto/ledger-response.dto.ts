import { z } from 'zod';
import { pageResponseSchema } from '../../../core/pagination/page-response.dto.js';
import { isoDateTimeSchema } from '../../../core/validation/iso-date-time.dto.js';
import { metadataSchema } from '../../../core/validation/metadata.dto.js';
import type { ILedgerPage } from '../../application/ports/ledger-repository.port.js';
import type { Ledger } from '../../domain/entities/ledger.entity.js';
import { ledgerNameSchema } from './ledger-name.dto.js';
import { encodeLedgerCursor } from './ledger-page-cursor.dto.js';

/**
 * A ledger as clients see it. Field names are part of the public API.
 * `organizationId` is not included: the caller already sent it in the header.
 *
 * The schema is the source of truth for the type and for the API description
 * (`openapi.json`), so the mapper below cannot drift from the documentation.
 */
export const ledgerResponseSchema = z.object({
  id: z.uuidv7().meta({ description: 'Id of the ledger, a UUIDv7 made by the ledger.' }),
  name: ledgerNameSchema,
  metadata: metadataSchema,
  createdAt: isoDateTimeSchema.meta({ description: 'When the ledger was created.' }),
});

export type LedgerResponseDto = z.infer<typeof ledgerResponseSchema>;

export function toLedgerResponseDto(ledger: Ledger): LedgerResponseDto {
  return {
    id: ledger.id,
    name: ledger.name,
    metadata: ledger.metadata.entries,
    createdAt: ledger.createdAt.toISOString(),
  };
}

/** One page of `GET /ledgers`. Field names are part of the public API. */
export const ledgerPageResponseSchema = pageResponseSchema(ledgerResponseSchema, 'sorted by name');

export type LedgerPageResponseDto = z.infer<typeof ledgerPageResponseSchema>;

export function toLedgerPageResponseDto(page: ILedgerPage): LedgerPageResponseDto {
  const last = page.ledgers.at(-1);
  return {
    data: page.ledgers.map(toLedgerResponseDto),
    hasMore: page.hasMore,
    // `last` is always there when `hasMore` is true, because a page holds at
    // least one ledger. The check is only for the type.
    next: page.hasMore && last !== undefined ? encodeLedgerCursor(last.name) : undefined,
  };
}
