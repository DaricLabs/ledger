import { readFile, writeFile } from 'node:fs/promises';
import { buildLedgerOpenApiDocument, serializeOpenApiDocument } from './ledger-api.oas.js';

/**
 * Writes `openapi.json` next to `package.json`. Run it with
 * `pnpm openapi:generate` after a change to a route, a schema or a text in an
 * `*.oas.ts` file. A test fails when the file is out of date.
 */
const packageJsonUrl = new URL('../../package.json', import.meta.url);
const outputUrl = new URL('../../openapi.json', import.meta.url);

const { version } = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as { version: string };
await writeFile(outputUrl, serializeOpenApiDocument(buildLedgerOpenApiDocument(version)));
console.log('Wrote apps/ledger-api/openapi.json');
