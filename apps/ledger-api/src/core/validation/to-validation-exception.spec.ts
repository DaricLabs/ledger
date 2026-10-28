import { toValidationException } from './to-validation-exception.js';

describe('toValidationException', () => {
  it('joins path segments with dots, for keys and { key } objects', () => {
    const error = toValidationException([
      { message: 'Required', path: ['postings', 0, { key: 'amount' }] },
    ]);

    expect(error.details).toEqual([{ path: 'postings.0.amount', message: 'Required' }]);
  });

  it('uses an empty path for an issue on the whole value', () => {
    const error = toValidationException([{ message: 'Expected object' }]);

    expect(error.details).toEqual([{ path: '', message: 'Expected object' }]);
  });

  it('keeps every issue, in order', () => {
    const error = toValidationException([
      { message: 'a', path: ['x'] },
      { message: 'b', path: ['y'] },
    ]);

    expect(error.details.map((d) => d.path)).toEqual(['x', 'y']);
  });

  it('is a 400 exception', () => {
    expect(toValidationException([]).getStatus()).toBe(400);
  });
});
