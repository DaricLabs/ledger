import type { Params } from 'nestjs-pino';
import type { LogLevel } from './log-levels.js';
import { resolveRequestId } from './request-id.js';

/** Probes call this often. Logging it would only add noise. */
const HEALTH_PATH = '/health';

export interface LoggerParamsOptions {
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
export function buildLoggerParams(options: LoggerParamsOptions): Params {
  const pinoHttp = {
    level: options.level,
    // Replaces pino's default `pid` and `hostname`; the log collector knows the host.
    base: { service: options.serviceName },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
    genReqId: resolveRequestId,
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
