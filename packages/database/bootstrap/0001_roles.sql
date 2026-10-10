-- Safe to re-run. Run as admin, connected to the target database.

-- Create each role only if it is missing (roles are server-wide)
do $$
begin
  if not exists (select from pg_roles where rolname = 'ledger_migrator') then
    create role ledger_migrator login;
  end if;
  if not exists (select from pg_roles where rolname = 'ledger_runtime') then
    create role ledger_runtime login;
  end if;
end $$;

-- Re-applies safe attributes and the password on every run
alter role ledger_migrator nosuperuser nobypassrls nocreatedb nocreaterole password :'migrator_password';
alter role ledger_runtime  nosuperuser nobypassrls nocreatedb nocreaterole password :'runtime_password';

grant connect on database :"dbname" to ledger_migrator, ledger_runtime;

-- PG15+ no longer lets everyone create objects in "public"
grant usage, create on schema public to ledger_migrator;
grant usage on schema public to ledger_runtime;

-- Tables and sequences the migrator creates later become usable by the app
alter default privileges for role ledger_migrator in schema public
  grant select, insert, update, delete on tables to ledger_runtime;
alter default privileges for role ledger_migrator in schema public
  grant usage, select on sequences to ledger_runtime;