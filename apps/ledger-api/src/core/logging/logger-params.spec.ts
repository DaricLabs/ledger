import type { IncomingMessage, ServerResponse } from 'node:http';
import { levelForResponse } from './logger-params.js';

const level = (statusCode: number, err?: Error) =>
  levelForResponse({} as IncomingMessage, { statusCode } as ServerResponse, err);

describe('levelForResponse', () => {
  it.each([
    [200, 'info'],
    [302, 'info'],
    [400, 'warn'],
    [404, 'warn'],
    [499, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ])('uses the status: %i -> %s', (status, expected) => {
    expect(level(status)).toBe(expected);
  });

  it('logs an error on the response stream as error, even with a 200 status', () => {
    expect(level(200, new Error('socket write failed'))).toBe('error');
  });

  it('keeps a client error (4xx) at warn, even when an error is present', () => {
    expect(level(404, new Error('not found'))).toBe('warn');
  });
});
