import type { ErrorCode } from './error-code.js';

/** One invalid field in a `VALIDATION` error. `path` is dotted, like `postings.0.amount`. */
export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The body of every error response. Same field names as Formance
 * (`errorCode`, `errorMessage`), so Formance-style clients feel familiar.
 *
 * `details` is only sent for `VALIDATION` errors.
 */
export interface ErrorResponse {
  errorCode: ErrorCode;
  errorMessage: string;
  details?: ErrorDetail[];
}
