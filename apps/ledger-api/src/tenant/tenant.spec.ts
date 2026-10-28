import { Writable } from 'node:stream';
import { Controller, Get, UseGuards, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerParams } from '../logging/logger-params.js';
import { OrganizationId } from './organization-id.decorator.js';
import { ORGANIZATION_ID_HEADER, TenantGuard } from './tenant.guard.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const UUID_V4 = '3b241101-e2bb-4255-8caf-4136c566a962';

@Controller()
class ProbeController {
  @Get('guarded')
  @UseGuards(TenantGuard)
  guarded(@OrganizationId() organizationId: string) {
    return { organizationId };
  }

  @Get('unguarded')
  unguarded(@OrganizationId() organizationId: string) {
    return { organizationId };
  }
}

describe('tenant guard + @OrganizationId()', () => {
  let app: INestApplication;
  let baseUrl: string;
  const lines: { msg?: string; organization_id?: string }[] = [];

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
      ],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false); // turns off Nest's own logs (like the expected 500 error) for this test app
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  const get = (path: string, orgId?: string) =>
    fetch(`${baseUrl}${path}`, {
      headers: orgId === undefined ? {} : { [ORGANIZATION_ID_HEADER]: orgId },
    });

  it('rejects a missing header with 400', async () => {
    expect((await get('/guarded')).status).toBe(400);
  });

  it.each([
    ['not a uuid', 'abc'],
    ['an empty value', ''],
    ['a UUIDv4', UUID_V4],
  ])('rejects %s with 400', async (_label, value) => {
    expect((await get('/guarded', value)).status).toBe(400);
  });

  it('does not echo the header value in the error', async () => {
    const res = await get('/guarded', 'leaky-value-123');

    expect(JSON.stringify(await res.json())).not.toContain('leaky-value-123');
  });

  it('passes a valid UUIDv7 to the handler', async () => {
    const res = await get('/guarded', ORG_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: ORG_ID });
  });

  it('lowercases the id', async () => {
    const res = await get('/guarded', ORG_ID.toUpperCase());

    expect(await res.json()).toEqual({ organizationId: ORG_ID });
  });

  it('adds organization_id to the request log', async () => {
    await get('/guarded', ORG_ID);

    await vi.waitFor(() => {
      const done = lines.find((l) => l.msg === 'request completed');
      expect(done?.organization_id).toBe(ORG_ID);
    });
  });

  it('fails with 500 when a route uses the decorator without the guard', async () => {
    expect((await get('/unguarded', ORG_ID)).status).toBe(500);
  });
});
