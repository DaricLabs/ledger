import { z } from 'zod';

/** One invalid field in a `VALIDATION` error. */
export const errorDetailSchema = z.object({
  path: z.string().meta({
    description: 'The bad field, dotted, like `postings.0.amount`.',
    examples: ['postings.0.amount'],
  }),
  message: z.string().meta({ description: 'What is wrong with it.' }),
});

/**
 * The body of every error response. Same field names as Formance
 * (`errorCode`, `errorMessage`), so Formance-style clients feel familiar.
 *
 * `errorCode` is one of the core codes in `ERROR_CODES`, or a domain code
 * from a feature, like `LEDGER_NOT_FOUND`.
 * `details` is only sent for `VALIDATION` errors.
 */
export const errorResponseSchema = z.object({
  errorCode: z.string().meta({
    description:
      'A stable code to switch on, like `LEDGER_NOT_FOUND`. New codes can be added at any ' +
      'time, so a client must handle a code it does not know by the HTTP status.',
    examples: ['LEDGER_NOT_FOUND'],
  }),
  errorMessage: z.string().meta({
    description: 'A message for people. It can change at any time, so do not switch on it.',
  }),
  details: z
    .array(errorDetailSchema)
    .optional()
    .meta({ description: 'One entry for each bad field. Only sent with `VALIDATION`.' }),
});

export type ErrorDetailDto = z.infer<typeof errorDetailSchema>;
export type ErrorResponseDto = z.infer<typeof errorResponseSchema>;
