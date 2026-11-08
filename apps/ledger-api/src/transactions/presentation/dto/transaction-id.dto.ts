import { z } from 'zod';

/**
 * A transaction id in a URL. It checks the shape only: a UUIDv7, like the ids
 * the ledger makes. A badly shaped id is a `VALIDATION` error (400) and never
 * reaches the database, which would refuse it with a harder error.
 */
export const transactionIdSchema = z.uuidv7();
