import { DomainError } from './domain.error.js';

class ExampleError extends DomainError {
  readonly code = 'EXAMPLE';
}

describe('DomainError', () => {
  it('is an Error that keeps the message and the code of the subclass', () => {
    const error = new ExampleError('something broke');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('something broke');
    expect(error.code).toBe('EXAMPLE');
  });

  it('sets the name from the class that was created', () => {
    expect(new ExampleError().name).toBe('ExampleError');
  });

  it('keeps the cause', () => {
    const cause = new Error('database is down');

    expect(new ExampleError('something broke', { cause }).cause).toBe(cause);
  });
});
