import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { toErrorResponse } from './to-error-response.js';

/**
 * Catches every error thrown while handling an HTTP request and sends the
 * one error body format (`ErrorResponse`).
 *
 * It does not log. `LoggerErrorInterceptor` attaches the error to the
 * response, so the final request log line of a failed request carries it.
 * Logging here too would write each failure twice.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = toErrorResponse(exception);
    response.status(status).json(body);
  }
}
