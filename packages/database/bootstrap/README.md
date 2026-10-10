# Bootstrap

One-time setup that creates the two database users. It is **not** a migration.

## Who runs it

An admin (a superuser or a user with CREATEROLE), never the app and never the normal deploy pipeline.

## Roles it creates

| Role              | Used by                       | Can do                                          |
| ----------------- | ----------------------------- | ----------------------------------------------- |
| `ledger_migrator` | `pnpm migrate` only           | Create and change tables (owns them)            |
| `ledger_runtime`  | `ledger-api`, `ledger-worker` | Only the access granted per table in migrations |

`ledger_runtime` must NOT be superuser or have BYPASSRLS. Row-level security
(tenant isolation) does not apply to such roles.

## Before you run it

- The database must already exist (it connects to the target database).
- Postgres 15 or newer.

## Run it

```bash
psql "$LEDGER_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v dbname=ledger \
  -v migrator_password="$MIGRATOR_PW" -v runtime_password="$RUNTIME_PW" \
  -f packages/database/bootstrap/0001_roles.sql
```

With Postgres in Docker and no local `psql`:

```bash
docker compose exec -T postgres psql -U postgres -d ledger -v ON_ERROR_STOP=1 \
  -v dbname=ledger -v migrator_password="$MIGRATOR_PW" -v runtime_password="$RUNTIME_PW" \
  -f - < packages/database/bootstrap/0001_roles.sql
```

## Safe to re-run

Running it again fixes role attributes and rotates both passwords.

## Check it worked

```sql
select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
from pg_roles where rolname like 'ledger_%';
```

All four flags must be `false`.

## Order

1. bootstrap (admin) -> 2. `pnpm migrate` (migrator) -> 3. app runs (runtime)
