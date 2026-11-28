-- Safe to re-run. Run as a superuser, connected to the target database.

-- Create each role only if it is missing (roles are server-wide)
do $$
begin
  if not exists (select from pg_roles where rolname = 'ledger_migrator') then
    create role ledger_migrator login;
  end if;
  if not exists (select from pg_roles where rolname = 'ledger_runtime') then
    create role ledger_runtime login;
  end if;
  if not exists (select from pg_roles where rolname = 'ledger_relay') then
    create role ledger_relay login;
  end if;
end $$;

-- Re-applies safe attributes and the password on every run
alter role ledger_migrator nosuperuser nobypassrls nocreatedb nocreaterole password :'migrator_password';
alter role ledger_runtime  nosuperuser nobypassrls nocreatedb nocreaterole password :'runtime_password';
alter role ledger_relay    nosuperuser nobypassrls nocreatedb nocreaterole password :'relay_password';

grant connect on database :"dbname" to ledger_migrator, ledger_runtime, ledger_relay;

-- PG15+ no longer lets everyone create objects in "public"
grant usage, create on schema public to ledger_migrator;
grant usage on schema public to ledger_runtime, ledger_relay;

-- Tables are NOT granted automatically. Each migration that creates a table
-- must grant what ledger_runtime (and ledger_relay, if it needs the table) needs.
-- A table with no grant fails loudly with "permission denied". This only affects tables created later.
-- Grants already on existing tables are not removed (reset a dev database instead).
alter default privileges for role ledger_migrator in schema public
  revoke all on tables from ledger_runtime, ledger_relay;

-- Sequences (identity columns) are safe to share: the app needs them to insert
alter default privileges for role ledger_migrator in schema public
  grant usage, select on sequences to ledger_runtime;
