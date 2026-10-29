import { Writable } from 'node:stream';
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { buildLoggerParams } from '../logging/logger-params.js';
import { ORGANIZATION_ID_HEADER, TenantGuard } from '../tenant/tenant.guard.js';
import { ValidationModule } from '../validation/validation.module.js';
import { ErrorsModule } from './errors.module.js';

const createLedgerSchema = z.object({
  name: z.string().min(1),
  postings: z.array(z.object({ amount: z.number().int().positive() })).default([]),
});

@Controller()
class ProbeController {
  @Get('not-found')
  notFound() {
    throw new NotFoundException('Ledger not found');
  }

  @Get('boom')
  boom() {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  }

  @Get('guarded')
  @UseGuards(TenantGuard)
  guarded() {
    return { ok: true };
  }

  @Post('ledgers')
  create(@Body({ schema: createLedgerSchema }) body: z.infer<typeof createLedgerSchema>) {
    return body;
  }
}

describe('error responses (real Nest app)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const lines: { level: number; msg?: string; err?: { message?: string } }[] = [];

  beforeAll(async () => {
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const text of chunk.toString().split('\n').filter(Boolean)) {
          lines.push(JSON.parse(text));
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
        ErrorsModule,
        ValidationModule,
      ],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  const postJson = (path: string, body: string) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('formats an HttpException', async () => {
    const res = await fetch(`${baseUrl}/not-found`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ errorCode: 'NOT_FOUND', errorMessage: 'Ledger not found' });
  });

  it('formats the unknown route 404 of Nest', async () => {
    const res = await fetch(`${baseUrl}/no-such-route`);

    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe('NOT_FOUND');
  });

  it('formats the TenantGuard 400', async () => {
    const res = await fetch(`${baseUrl}/guarded`, { headers: { [ORGANIZATION_ID_HEADER]: 'abc' } });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      errorCode: 'INVALID_REQUEST',
      errorMessage: 'X-Organization-Id header is missing or not a valid UUIDv7',
    });
  });

  it('turns an unknown error into a plain 500 and never leaks it', async () => {
    const res = await fetch(`${baseUrl}/boom`);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      errorCode: 'INTERNAL',
      errorMessage: 'Internal server error',
    });
    expect(text).not.toContain('hunter2');
  });

  it('logs the real error once, on the request log line', async () => {
    await fetch(`${baseUrl}/boom`);

    await vi.waitFor(() => {
      const failed = lines.filter((l) => l.level >= 50);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.msg).toBe('request errored');
      expect(failed[0]?.err?.message).toContain('ECONNREFUSED');
    });
  });

  it('logs a client error (4xx) as a warning, not an error', async () => {
    await fetch(`${baseUrl}/not-found`);

    await vi.waitFor(() => {
      expect(lines.map((l) => l.level)).toEqual([40]);
    });
  });

  it('accepts a valid body and applies the schema defaults', async () => {
    const res = await postJson('/ledgers', JSON.stringify({ name: 'main' }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: 'main', postings: [] });
  });

  it('returns VALIDATION with one detail per invalid field', async () => {
    const res = await postJson(
      '/ledgers',
      JSON.stringify({ name: '', postings: [{ amount: 5 }, { amount: -1 }] }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.errorCode).toBe('VALIDATION');
    expect(body.errorMessage).toBe('Request validation failed');
    expect(body.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'name',
      'postings.1.amount',
    ]);
  });

  it('returns VALIDATION when the body is missing', async () => {
    const res = await fetch(`${baseUrl}/ledgers`, { method: 'POST' });

    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe('VALIDATION');
  });

  it('returns a 400 INVALID_REQUEST for malformed JSON, not a 500', async () => {
    const res = await postJson('/ledgers', '{"name":');

    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe('INVALID_REQUEST');
  });
});
