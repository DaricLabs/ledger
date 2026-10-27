import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { resolveRequestId } from './request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(headerValue?: string | string[]) {
  const setHeader = vi.fn();
  const req = { headers: { 'x-request-id': headerValue } } as unknown as IncomingMessage;
  const res = { setHeader } as unknown as ServerResponse;
  return { id: resolveRequestId(req, res), setHeader };
}

describe('resolveRequestId', () => {
  it('reuses a safe id from the gateway', () => {
    expect(run('gw-123:abc.4_5').id).toBe('gw-123:abc.4_5');
  });

  it('creates a UUID when the header is missing', () => {
    expect(run(undefined).id).toMatch(UUID);
  });

  it.each([
    ['has spaces', 'bad id'],
    ['has quotes', '"x"'],
    ['is empty', ''],
    ['is longer than 128 characters', 'a'.repeat(129)],
    ['is repeated (array)', ['a', 'b']],
  ])('creates a UUID when the header %s', (_label, value) => {
    expect(run(value).id).toMatch(UUID);
  });

  it('accepts exactly 128 characters', () => {
    const id = 'a'.repeat(128);
    expect(run(id).id).toBe(id);
  });

  it('sends the id back in the response header', () => {
    const { id, setHeader } = run('gw-1');
    expect(setHeader).toHaveBeenCalledExactlyOnceWith('x-request-id', id);
  });
});
