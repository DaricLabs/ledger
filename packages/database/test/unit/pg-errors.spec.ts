import { isUniqueViolation } from '../../src/pg-errors.js';
import { SqlState } from '../../src/sql-state.js';

const CONSTRAINT = 'ledgers_organization_id_name_key';

/** An error with the same fields that `pg` puts on a database error. */
const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error('database error'), { code, constraint });

describe('isUniqueViolation', () => {
  it('is true for a unique violation of the named constraint', () => {
    expect(isUniqueViolation(pgError(SqlState.UniqueViolation, CONSTRAINT), CONSTRAINT)).toBe(true);
  });

  it('is false for a unique violation of another constraint', () => {
    expect(isUniqueViolation(pgError(SqlState.UniqueViolation, 'ledgers_pkey'), CONSTRAINT)).toBe(
      false,
    );
  });

  it('is false for another error code, even with the same constraint name', () => {
    expect(isUniqueViolation(pgError(SqlState.ForeignKeyViolation, CONSTRAINT), CONSTRAINT)).toBe(
      false,
    );
  });

  it('is false when the error has the code but no constraint', () => {
    expect(isUniqueViolation(pgError(SqlState.UniqueViolation), CONSTRAINT)).toBe(false);
  });

  it('is false for a plain Error', () => {
    expect(isUniqueViolation(new Error('boom'), CONSTRAINT)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', SqlState.UniqueViolation],
    ['a number', 23505],
  ])('is false when %s was thrown', (_label, thrown) => {
    expect(isUniqueViolation(thrown, CONSTRAINT)).toBe(false);
  });
});
