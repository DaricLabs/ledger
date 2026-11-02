import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { toErrorResponse } from './to-error-response.js';
import { ValidationFailedException } from './validation-failed-exception.js';

describe('toErrorResponse', () => {
  it('maps a ValidationFailedException to VALIDATION with details', () => {
    const details = [{ path: 'name', message: 'Invalid ledger name' }];

    expect(toErrorResponse(new ValidationFailedException(details))).toEqual({
      status: 400,
      body: { errorCode: 'VALIDATION', errorMessage: 'Request validation failed', details },
    });
  });

  it.each([
    ['BadRequestException', new BadRequestException('bad'), 400, 'INVALID_REQUEST'],
    ['UnauthorizedException', new UnauthorizedException('no'), 401, 'UNAUTHORIZED'],
    ['ForbiddenException', new ForbiddenException('no'), 403, 'FORBIDDEN'],
    ['NotFoundException', new NotFoundException('gone'), 404, 'NOT_FOUND'],
    ['ConflictException', new ConflictException('dup'), 409, 'CONFLICT'],
    ['an unmapped 4xx (429)', new HttpException('slow down', 429), 429, 'INVALID_REQUEST'],
  ])('maps %s to its status and code, and keeps its message', (_name, error, status, code) => {
    expect(toErrorResponse(error)).toEqual({
      status,
      body: { errorCode: code, errorMessage: error.message },
    });
  });

  it('uses the errorCode option of an HttpException and keeps its message', () => {
    const error = new NotFoundException('Ledger "main" not found', {
      errorCode: 'LEDGER_NOT_FOUND',
    });

    expect(toErrorResponse(error)).toEqual({
      status: 404,
      body: { errorCode: 'LEDGER_NOT_FOUND', errorMessage: 'Ledger "main" not found' },
    });
  });

  it('hides the errorCode option and the message of a 5xx HttpException', () => {
    const error = new HttpException('db host=10.0.0.5', 500, { errorCode: 'LEDGER_BROKEN' });

    expect(toErrorResponse(error)).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorMessage: 'Internal server error' },
    });
  });

  it('maps an http-errors client error from the body parser (invalid JSON)', () => {
    const error = Object.assign(new Error('Unexpected token } in JSON'), {
      status: 400,
      expose: true,
    });

    expect(toErrorResponse(error)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_REQUEST', errorMessage: 'Unexpected token } in JSON' },
    });
  });

  it('does not trust a plain error that only has a status, without expose', () => {
    const error = Object.assign(new Error('db password is x'), { status: 400 });

    expect(toErrorResponse(error).status).toBe(500);
  });

  it('hides the message of a 5xx HttpException', () => {
    const result = toErrorResponse(new ServiceUnavailableException('pool exhausted: host=db1'));

    expect(result).toEqual({
      status: 503,
      body: { errorCode: 'UNAVAILABLE', errorMessage: 'Service unavailable' },
    });
  });

  it('turns an HttpException with a status below 400 into a plain 500', () => {
    expect(toErrorResponse(new HttpException('moved', 302))).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorMessage: 'Internal server error' },
    });
  });

  it.each([
    ['an Error', new Error('connect ECONNREFUSED 10.0.0.5:5432')],
    ['a string', 'boom'],
    ['undefined', undefined],
  ])('turns %s into a plain 500 with no internals', (_name, thrown) => {
    expect(toErrorResponse(thrown)).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorMessage: 'Internal server error' },
    });
  });
});
