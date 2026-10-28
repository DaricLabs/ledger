import { HttpException } from '@nestjs/common';
import type { ErrorCode } from './error-code.js';
import type { ErrorResponse } from './error-response.js';
import { ValidationFailedException } from './validation-failed-exception.js';

const INTERNAL_MESSAGE = 'Internal server error';

/** Status codes that have their own `errorCode`. Other 4xx use `INVALID_REQUEST`, other 5xx use `INTERNAL`. */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  503: 'UNAVAILABLE',
};

/**
 * Turns anything that was thrown into the HTTP status and the error body.
 *
 * Never puts internal details in the body: unknown errors and all 5xx errors
 * get a fixed message, and the real error stays in the logs.
 */
export function toErrorResponse(exception: unknown): { status: number; body: ErrorResponse } {
  if (exception instanceof ValidationFailedException) {
    return {
      status: exception.getStatus(),
      body: {
        errorCode: 'VALIDATION',
        errorMessage: exception.message,
        details: exception.details,
      },
    };
  }

  const status = readClientStatus(exception);
  if (status !== undefined) {
    return {
      status,
      body: { errorCode: codeForStatus(status), errorMessage: (exception as Error).message },
    };
  }

  const serverStatus = exception instanceof HttpException ? exception.getStatus() : 500;
  const errorCode = codeForStatus(serverStatus);
  return {
    status: serverStatus,
    body: {
      errorCode,
      errorMessage: errorCode === 'UNAVAILABLE' ? 'Service unavailable' : INTERNAL_MESSAGE,
    },
  };
}

function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL' : 'INVALID_REQUEST');
}

/**
 * Returns the status when the error is safe to show as a client error (4xx):
 * a Nest `HttpException`, or an `http-errors` error from the body parser
 * (for example invalid JSON or a body that is too large). Returns
 * `undefined` for everything else, so it becomes a plain 500.
 */
function readClientStatus(exception: unknown): number | undefined {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return status >= 400 && status < 500 ? status : undefined;
  }
  if (exception instanceof Error) {
    const { status, expose } = exception as Error & { status?: unknown; expose?: unknown };
    if (typeof status === 'number' && status >= 400 && status < 500 && expose === true) {
      return status;
    }
  }
  return undefined;
}
