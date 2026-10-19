# Bootstrap

One-time setup that creates the two database users. It is **not** a migration.

## Who runs it

A **superuser** (for example `postgres`), never the app and never the normal deploy pipeline.

A user with only `CREATEROLE` is not enough. Changing `NOBYPASSRLS` needs a superuser, and the default privileges step needs membership in `ledger_migrator`.

## Roles it creates

| Role              | Used by                       | Can do                                         |
| ----------------- | ----------------------------- | ---------------------------------------------- |
| `ledger_migrator` | `pnpm migrate` only           | Create and change tables (owns them)           |
| `ledger_runtime`  | `ledger-api`, `ledger-worker` | Only what each migration grants it (see below) |

Tables are **not** granted automatically. Every migration that creates a table must also `grant` the least access `ledger_runtime` needs (see the end of `0001_init.sql`). A table without a grant fails with `permission denied`, so a missing grant is easy to notice. Append-only tables get `select, insert` only; this protects them even if a trigger is dropped by mistake.

`ledger_runtime` must NOT be superuser or have BYPASSRLS. Row-level security
(tenant isolation) does not apply to such roles.

## Before you run it

- The database must already exist (the script connects to it).
- Postgres 15 or newer.

## Run it

```bash
psql "$LEDGER_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v dbname=ledger \
  -v migrator_password="$MIGRATOR_PW" -v runtime_password="$RUNTIME_PW" \
  -f packages/database/bootstrap/0001_roles.sql
```

`LEDGER_ADMIN_DATABASE_URL` must connect as a superuser.

With Postgres in Docker and no local `psql`:

```bash
docker compose exec -T postgres psql -U postgres -d ledger -v ON_ERROR_STOP=1 \
  -v dbname=ledger -v migrator_password="$MIGRATOR_PW" -v runtime_password="$RUNTIME_PW" \
  -f - < packages/database/bootstrap/0001_roles.sql
```

## Safe to re-run

Running it again fixes role attributes and rotates both passwords.

If it fails halfway (for example, you ran it as a non-superuser), fix the cause
and run it again. Nothing needs to be cleaned up first.

## Compose helper

`compose-entrypoint.sh` is used only by the `bootstrap` service in the compose
files. It waits for Postgres, then runs the SQL file. For real environments,
use the `psql` command above and skip this script.

## Check it worked

```sql
select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
from pg_roles
where rolname in ('ledger_migrator', 'ledger_runtime');
```

You should see two rows, and all four flags must be `false`.

## Order

1. bootstrap (superuser) -> 2. `pnpm migrate` (migrator) -> 3. app runs (runtime)
