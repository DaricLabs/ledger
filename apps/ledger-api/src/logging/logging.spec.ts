import { Writable } from 'node:stream';
import {
  Controller,
  Get,
  Inject,
  Logger as NestLogger,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule, PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLoggerParams } from './logger-params.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LogLine {
  level: number;
  msg?: string;
  service?: string;
  context?: string;
  organization_id?: string;
  req?: { id?: string; url?: string; headers?: Record<string, string> };
}

@Controller()
class ProbeController {
  private readonly logger = new NestLogger(ProbeController.name);

  constructor(@Inject(PinoLogger) private readonly pino: PinoLogger) {}

  @Get('probe')
  probe() {
    this.pino.assign({ organization_id: ORG_ID });
    this.logger.log('inside handler');
    return { ok: true };
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

describe('logging (real Nest app, real pino-http)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const lines: LogLine[] = [];

  beforeAll(async () => {
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const text of chunk.toString().split('\n').filter(Boolean)) {
          lines.push(JSON.parse(text) as LogLine);
        }
        callback();
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot(
          buildLoggerParams({
            serviceName: 'ledger-api',
            level: 'info',
            pretty: false,
            destination,
          }),
        ),
      ],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  const completed = (id: string) =>
    vi.waitFor(() => {
      const line = lines.find((l) => l.msg === 'request completed' && l.req?.id === id);
      expect(line).toBeDefined();
      return line!;
    });

  it('reuses X-Request-Id on the response, the handler log and the final log', async () => {
    const res = await fetch(`${baseUrl}/probe`, { headers: { 'x-request-id': 'gw-42' } });

    const done = await completed('gw-42');
    const inHandler = lines.find((l) => l.msg === 'inside handler');
    expect(res.headers.get('x-request-id')).toBe('gw-42');
    expect(inHandler?.req?.id).toBe('gw-42');
    expect(inHandler?.context).toBe('ProbeController');
    expect(done.service).toBe('ledger-api');
  });

  it('creates a request id when none is sent, or when it is unsafe', async () => {
    const none = await fetch(`${baseUrl}/probe`);
    const unsafe = await fetch(`${baseUrl}/probe`, { headers: { 'x-request-id': 'bad id' } });

    expect(none.headers.get('x-request-id')).toMatch(UUID);
    expect(unsafe.headers.get('x-request-id')).toMatch(UUID);
  });

  it('puts fields from assign() (organization_id) on app logs and the final log', async () => {
    await fetch(`${baseUrl}/probe`, { headers: { 'x-request-id': 'gw-org' } });

    const done = await completed('gw-org');
    const inHandler = lines.find((l) => l.msg === 'inside handler');
    expect(inHandler?.organization_id).toBe(ORG_ID);
    expect(done.organization_id).toBe(ORG_ID);
  });

  it('redacts the authorization header and never prints the secret', async () => {
    await fetch(`${baseUrl}/probe`, {
      headers: { 'x-request-id': 'gw-auth', authorization: 'Bearer top-secret-token' },
    });

    const done = await completed('gw-auth');
    expect(done.req?.headers?.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(lines)).not.toContain('top-secret-token');
  });

  it('does not log health checks', async () => {
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/probe`, { headers: { 'x-request-id': 'gw-after' } });

    await completed('gw-after');
    expect(lines.filter((l) => l.req?.url === '/health')).toEqual([]);
  });
});
