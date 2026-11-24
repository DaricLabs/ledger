import { z } from 'zod';

/**
 * A transaction id in a URL. It checks the shape only: a UUIDv7, like the ids
 * the ledger makes. A badly shaped id is a `VALIDATION` error (400) and never
 * reaches the database, which would refuse it with a harder error.
 */
export const transactionIdSchema = z.uuidv7().meta({
  description: 'Id of a transaction, a UUIDv7 made by the ledger.',
  examples: ['0194f0c2-7d5a-7c3e-9b1a-2f6d8e4a1c05'],
});
