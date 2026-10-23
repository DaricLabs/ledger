# Tests for `@ledger/database`

Only tests for this package live here: the schema (`migrations/`), the roles
(`bootstrap/`), `withTenant`, `createDb`, and the migration runner. Use cases, repositories
and HTTP belong to the apps.

| Folder         | Needs a database | Command                 |
| -------------- | ---------------- | ----------------------- |
| `unit/`        | No               | `pnpm test`             |
| `integration/` | Yes              | `pnpm test:integration` |
| `support/`     | -                | helpers shared by both  |

## Run the integration tests

The tests use the Postgres from `compose.test.yaml` (port 5433, data in RAM).
From the repo root, once per session:

```bash
# Start Postgres (use "docker compose" if you use Docker)
podman compose -f compose.test.yaml up -d postgres
# Create the two roles (ledger_migrator, ledger_runtime)
podman compose -f compose.test.yaml --profile setup run --rm --no-deps bootstrap
```

Then, from `packages/database`:

```bash
pnpm test:integration
```

Before the first test, a global setup applies the migrations as `ledger_migrator`.
The tests connect as `ledger_runtime` (the role the apps use), so row-level
security and grants are really tested. A few tests use `ledger_migrator`, the table
owner, to check that triggers stop even the owner.

## Good to know

- **Reset after you edit `0001_init.sql`.** Migrations run only once per database.
  Recreate it with `compose down` and the two commands above.
- **Tests never clean up.** Each test uses new random tenant ids, so data does not
  clash. The database is meant to be thrown away.
- **Another database:** set `TEST_LEDGER_MIGRATOR_DATABASE_URL` and
  `TEST_LEDGER_RUNTIME_DATABASE_URL`. These names differ from the `LEDGER_*` ones on
  purpose, so tests never run against your dev database by accident.
- **New table?** `roles.integration-spec.ts` and `row-level-security.integration-spec.ts`
  fail until you add it to their lists. That is on purpose: every grant and every
  policy should be a conscious decision.
