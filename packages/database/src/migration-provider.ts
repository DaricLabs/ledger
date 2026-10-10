import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Kysely, sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

/**
 * A Kysely migration provider that loads SQL migrations from a specified directory.
 *
 * Each `.sql` file in the directory is treated as a single migration.
 * The migration name is derived from the file name (excluding the `.sql` extension).
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  /**
   * Creates a new SQL file migration provider.
   *
   * @param dir - The absolute or relative path to the directory containing the `.sql` migration files.
   */
  constructor(private readonly dir: string) {}

  /**
   * Reads all `.sql` files from the configured directory and converts them into Kysely Migration objects.
   *
   * @returns A record mapping migration names (file names without `.sql`) to their corresponding
   *          migration definitions. Each definition contains an `up` method that executes the file's SQL content.
   */
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.sql'));
    const migrations: Record<string, Migration> = {};

    for (const file of files) {
      const name = file.replace(/\.sql$/, '');
      const filePath = join(this.dir, file);

      migrations[name] = {
        async up(db: Kysely<any>) {
          await sql.raw(await readFile(filePath, 'utf-8')).execute(db);
        },
      };
    }

    return migrations;
  }
}
