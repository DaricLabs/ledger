import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Kysely runs migrations in alphabetical order and refuses to continue if an
// already-applied migration sorts after a new one. Zero-padded numbers keep
// alphabetical order and numeric order the same.
const MIGRATIONS_DIR = join(import.meta.dirname, '../../migrations');
const NAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

describe('migration files', () => {
  it('has at least one migration', async () => {
    const files = await readdir(MIGRATIONS_DIR);

    expect(files.filter((f) => f.endsWith('.sql')).length).toBeGreaterThan(0);
  });

  it('only contains files named NNNN_snake_case_name.sql', async () => {
    const files = await readdir(MIGRATIONS_DIR);

    const badNames = files.filter((f) => !NAME_PATTERN.test(f));

    expect(badNames).toEqual([]);
  });

  it('never reuses a migration number', async () => {
    const files = await readdir(MIGRATIONS_DIR);

    const numbers = files.map((f) => NAME_PATTERN.exec(f)?.[1]).filter(Boolean);

    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
