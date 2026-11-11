/** One invalid field in a `VALIDATION` error. `path` is dotted, like `postings.0.amount`. */
export interface IErrorDetail {
  path: string;
  message: string;
}

/**
 * The body of every error response. Same field names as Formance
 * (`errorCode`, `errorMessage`), so Formance-style clients feel familiar.
 *
 * `errorCode` is one of the core codes in `ERROR_CODES`, or a domain code
 * from a feature, like `LEDGER_NOT_FOUND`.
 * `details` is only sent for `VALIDATION` errors.
 */
export interface IErrorResponse {
  errorCode: string;
  errorMessage: string;
  details?: IErrorDetail[];
}
