import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { LogLevel } from './log-level.constant.js';

/** Probes call this often. Logging it would only add noise. */
const HEALTH_PATH = '/health';

export const REQUEST_ID_HEADER = 'x-request-id';

// Plain and short, because the id goes into every log line and a response header.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Returns the request id for one HTTP request and sends it back to the caller.
 *
 * The gateway sends `X-Request-Id`. If it is there and looks safe, it is reused,
 * so one id follows the request across services. Otherwise a new UUID is made.
 * The id is also set on the response, so callers can quote it in bug reports.
 *
 * Used as `genReqId` of pino-http.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * pino-http logs every request at `info` unless told otherwise, so a 500
 * would never show up as an error. The level follows the status code, or an
 * error on the response stream (a socket failure after the status was sent).
 * That error is the third argument. It is not the `res.err` that
 * `LoggerErrorInterceptor` sets, and those errors always have a 4xx or 5xx status.
 */
export function levelForResponse(
  _req: IncomingMessage,
  res: ServerResponse,
  err?: Error,
): LogLevel {
  if (res.statusCode >= 400 && res.statusCode < 500) return 'warn';
  if (res.statusCode >= 500 || err) return 'error';
  return 'info';
}

export interface ILoggerParamsOptions {
  /** Added to every log line as `service`. */
  serviceName: string;
  level: LogLevel;
  /** Human-readable output through `pino-pretty` (a dev dependency). Never use in production. */
  pretty: boolean;
  /** Where to write. Defaults to stdout. Tests pass their own stream. Not allowed with `pretty`. */
  destination?: NodeJS.WritableStream;
}

/**
 * Builds the options for `nestjs-pino`'s `LoggerModule`.
 *
 * Kept as a plain function, so it can be tested without the config system.
 * Request bodies are never logged (`metadata` is free-form and may hold secrets).
 */
export function buildLoggerParams(options: ILoggerParamsOptions): Params {
  const pinoHttp = {
    level: options.level,
    // Replaces pino's default `pid` and `hostname`; the log collector knows the host.
    base: { service: options.serviceName },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
    genReqId: resolveRequestId,
    customLogLevel: levelForResponse,
    autoLogging: { ignore: (req: { url?: string }) => req.url === HEALTH_PATH },
    ...(options.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  };

  return {
    pinoHttp: options.destination ? [pinoHttp, options.destination] : pinoHttp,
    // Fields added with `PinoLogger.assign` (like organization_id) also reach the
    // final "request completed" line.
    assignResponse: true,
  };
}
