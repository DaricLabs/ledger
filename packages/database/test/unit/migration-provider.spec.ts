import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlFileMigrationProvider } from '../../src/migration-provider.js';
import { createRecordingDb } from '../support/recording-db.js';

describe('SqlFileMigrationProvider', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ledger-migrations-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns no migrations for an empty directory', async () => {
    const migrations = await new SqlFileMigrationProvider(dir).getMigrations();

    expect(migrations).toEqual({});
  });

  it('names each migration after its file, without the .sql extension', async () => {
    await writeFile(join(dir, '0001_init.sql'), 'select 1;');
    await writeFile(join(dir, '0002_add_things.sql'), 'select 2;');

    const migrations = await new SqlFileMigrationProvider(dir).getMigrations();

    expect(Object.keys(migrations).sort()).toEqual(['0001_init', '0002_add_things']);
  });

  it('ignores files that are not .sql', async () => {
    await writeFile(join(dir, '0001_init.sql'), 'select 1;');
    await writeFile(join(dir, 'README.md'), '# notes');
    await writeFile(join(dir, '0002_draft.sql.bak'), 'select 2;');
    await mkdir(join(dir, 'archive'));

    const migrations = await new SqlFileMigrationProvider(dir).getMigrations();

    expect(Object.keys(migrations)).toEqual(['0001_init']);
  });

  it('runs the file content as one raw statement, without changing it', async () => {
    // `?`, `:name`, `$1` and `$$` must reach Postgres untouched.
    const content = [
      'create function f() returns int language sql as $$ select 1 $$;',
      "select '?' as q, ':name' as n, '$1' as d;",
      '',
    ].join('\n');
    await writeFile(join(dir, '0001_raw.sql'), content);
    const { db, events } = createRecordingDb();

    const migrations = await new SqlFileMigrationProvider(dir).getMigrations();
    await migrations['0001_raw'].up(db);

    expect(events).toEqual([{ type: 'query', sql: content, parameters: [] }]);
  });

  it('reads the file when up() runs, not when migrations are listed', async () => {
    const file = join(dir, '0001_late.sql');
    await writeFile(file, 'select 1;');
    const migrations = await new SqlFileMigrationProvider(dir).getMigrations();
    await writeFile(file, 'select 2;');
    const { db, events } = createRecordingDb();

    await migrations['0001_late'].up(db);

    expect(events).toEqual([{ type: 'query', sql: 'select 2;', parameters: [] }]);
  });

  it('fails when the directory does not exist', async () => {
    const provider = new SqlFileMigrationProvider(join(dir, 'missing'));

    await expect(provider.getMigrations()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
