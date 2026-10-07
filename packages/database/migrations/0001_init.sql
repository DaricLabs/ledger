-- =========================================================================
-- Daric Ledger — initial schema
-- PostgreSQL 15+
-- One dedicated database for the Ledger service.
-- =========================================================================
--
-- Tenancy model:
--   organization_id is an opaque reference to the Identity service; it is
--   not a foreign key to another database. Identity remains the source of
--   truth for organizations. Every table carries organization_id and is
--   further protected by a row-level-security tenant-isolation policy.
--
-- Money model:
--   Amounts and balances are integer minor units stored as numeric(78, 0)
--   to cover the uint256 magnitude range. PostgreSQL rounds input to the
--   declared scale BEFORE domain checks run, so fractional input cannot be
--   rejected by a domain check; integrality is validated at the API
--   boundary (DTO layer).
--
-- Audit model:
--   ledger_logs are written synchronously with ledger mutations. Each log
--   gets a per-ledger, gap-free `seq` (assigned by trigger under a lock on
--   the ledgers row), so seq order equals COMMIT order. A plain identity id
--   cannot give that guarantee. ledger_audit_anchors are written
--   asynchronously by a worker; each anchor must start at exactly
--   previous.to_log_seq + 1, so no log can be skipped.
--
-- Append-only note:
--   The append-only triggers stop normal clients. The table owner or a
--   superuser can still disable them, so real protection also needs a
--   least-privilege application role (no TRUNCATE, no ownership).
--
-- Stored-program policy:
--   Business logic for creating/reverting transactions lives in the
--   application (create-transaction.use-case.ts). PL/pgSQL is used ONLY to
--   enforce invariants that must hold regardless of which client writes the
--   tables: append-only protection, overdraft-flag sync, and audit-chain
--   continuity. This is a deliberate, narrow exception to the "no stored
--   procedures" guideline.
--
-- Idempotency model:
--   A lease (state + lock_expires_at) is used instead of holding a single
--   advisory-lock transaction, because callers may perform slow external
--   work (e.g. a PSP call) between check and completion and cannot keep a
--   database transaction open that long. Trade-off: a crashed holder
--   releases its lease only when lock_expires_at passes, not immediately on
--   disconnect.
-- =========================================================================


-- ---------- Domains ------------------------------------------------------

create domain uuidv7 as uuid
  check (
    value::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
-- Enforces UUID version 7 and the standard RFC variant bits.

create domain ledger_name as text
  check (value ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
-- Lowercase ledger names, max 63 characters.

create domain account_address as text
  check (
    value ~ '^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$'
    and length(value) <= 256
  );
-- Lowercase colon-separated account addresses, e.g. world, users:1, platform:fees.

create domain asset_code as text
  check (value ~ '^[A-Z][A-Z0-9]{2,15}$');
-- Uppercase asset codes, 3 to 16 characters, e.g. USD, EUR, BTC, ETH, USDC.

create domain json_obj as jsonb
  check (jsonb_typeof(value) = 'object');
-- Ensures JSON columns contain objects, not arrays or scalar values.

create domain money_amount_positive as numeric(78, 0)
  check (value > 0);
-- Positive integer minor units, sized to cover the uint256 magnitude range.
--
-- PostgreSQL coerces input to the declared scale (rounding) BEFORE domain
-- checks run, so a check such as "value = trunc(value)" could never fail on
-- numeric(x,0). Rejecting fractional input is therefore the caller's
-- responsibility and is enforced at the API boundary; this domain only
-- guarantees that stored values are whole, positive numbers.

create domain money_balance as numeric(78, 0);
-- Signed integer minor units; may be negative when overdraft is allowed.
-- The same scale-coercion caveat as money_amount_positive applies. Kept as a
-- domain for semantic typing and as a single point to add future constraints.

create domain sha256_digest as bytea
  check (octet_length(value) = 32);
-- Raw 32-byte SHA-256 digest. Every hash column uses this single bytea
-- representation for compactness and consistency; encode to hex only at
-- display/logging boundaries (encode(value, 'hex')).

create domain event_type as text
  check (
    value ~ '^[a-z0-9_]+(?:\.[a-z0-9_]+)+$'
    and length(value) <= 128
  );
-- Dotted lowercase event names, e.g. ledger.transaction.created.

create domain operation_name as text
  check (
    value ~ '^[a-z0-9_]+(?:\.[a-z0-9_]+)+$'
    and length(value) <= 128
  );
-- Dotted lowercase API operation names, e.g. transactions.create.


-- ---------- ledgers ------------------------------------------------------

create table ledgers (
  id              uuidv7 primary key,
  organization_id uuidv7 not null,
  name            ledger_name not null,
  metadata        json_obj not null default '{}',
  last_log_seq    bigint not null default 0,
  created_at      timestamptz not null default now(),

  unique (organization_id, name),
  unique (organization_id, id),

  constraint ledgers_last_log_seq_nonnegative check (last_log_seq >= 0)
);
-- Surrogate ledger ID with a tenant-scoped unique ledger name.
-- last_log_seq is the per-ledger log counter; only the ledger_logs
-- trigger below should change it.


-- ---------- accounts -----------------------------------------------------

create table accounts (
  organization_id uuidv7 not null,
  ledger_id       uuidv7 not null,
  address         account_address not null,
  metadata        json_obj not null default '{}',
  allow_overdraft boolean not null default false,
  created_at      timestamptz not null default now(),

  primary key (organization_id, ledger_id, address),

  foreign key (organization_id, ledger_id)
    references ledgers (organization_id, id)
);
-- Accounts are auto-created by the application when first used in postings.


-- ---------- transactions -------------------------------------------------

create table transactions (
  id                          uuidv7 primary key,
  organization_id             uuidv7 not null,
  ledger_id                   uuidv7 not null,
  reference                   text,
  posted_at                   timestamptz not null default now(),
  metadata                    json_obj not null default '{}',
  reverted_at                 timestamptz,
  reverted_by_transaction_id  uuidv7,
  created_at                  timestamptz not null default now(),

  unique (organization_id, ledger_id, id),
  unique (organization_id, ledger_id, reference),

  foreign key (organization_id, ledger_id)
    references ledgers (organization_id, id),

  foreign key (organization_id, ledger_id, reverted_by_transaction_id)
    references transactions (organization_id, ledger_id, id),

  constraint transactions_reference_length
    check (reference is null or (length(reference) between 1 and 128)),

  constraint transactions_revert_fields_consistent
    check (
      (reverted_at is null and reverted_by_transaction_id is null)
      or
      (reverted_at is not null and reverted_by_transaction_id is not null)
    )
);
-- Transactions are tenant-scoped and ledger-scoped.
-- reference is an optional external business identifier; NULLs are treated
-- as distinct by the unique constraint, so multiple rows may omit it.

create index idx_transactions_org_ledger_posted_at
  on transactions (organization_id, ledger_id, posted_at desc, id desc);
-- Supports time-range queries ordered by business time.


-- ---------- postings -----------------------------------------------------

create table postings (
  transaction_id      uuidv7 not null,
  organization_id     uuidv7 not null,
  ledger_id           uuidv7 not null,
  seq                 integer not null,
  source_account      account_address not null,
  destination_account account_address not null,
  asset               asset_code not null,
  amount              money_amount_positive not null,
  created_at          timestamptz not null default now(),

  primary key (transaction_id, seq),

  foreign key (organization_id, ledger_id, transaction_id)
    references transactions (organization_id, ledger_id, id),

  foreign key (organization_id, ledger_id, source_account)
    references accounts (organization_id, ledger_id, address),

  foreign key (organization_id, ledger_id, destination_account)
    references accounts (organization_id, ledger_id, address),

  constraint postings_seq_positive
    check (seq >= 1),

  constraint postings_seq_max
    check (seq <= 100),

  constraint postings_accounts_distinct
    check (source_account <> destination_account)
);
-- Postings are immutable legs of a transaction.
-- seq is bounded to [1, 100]. The upper bound is a deliberate business limit
-- enforced in DDL; changing it is a schema migration, not a configuration
-- change.

create index idx_postings_source
  on postings (organization_id, ledger_id, source_account, transaction_id desc, seq);
-- Supports source-side account history queries.

create index idx_postings_destination
  on postings (organization_id, ledger_id, destination_account, transaction_id desc, seq);
-- Supports destination-side account history queries.


-- ---------- balances -----------------------------------------------------

create table balances (
  organization_id  uuidv7 not null,
  ledger_id        uuidv7 not null,
  account_address  account_address not null,
  asset            asset_code not null,
  balance          money_balance not null default 0,
  allow_overdraft  boolean not null default false,
  updated_at       timestamptz not null default now(),

  primary key (organization_id, ledger_id, account_address, asset),

  foreign key (organization_id, ledger_id, account_address)
    references accounts (organization_id, ledger_id, address),

  constraint balances_nonnegative_unless_overdraft
    check (balance >= 0 or allow_overdraft)
);
-- Current balance projection, updated atomically with transactions.
-- allow_overdraft is a denormalised copy of accounts.allow_overdraft so the
-- non-negative check can be enforced locally (PostgreSQL CHECK constraints
-- cannot reference another table); it is kept in sync by triggers.


-- ---------- ledger_logs --------------------------------------------------

create table ledger_logs (
  id              bigint generated always as identity primary key,
  organization_id uuidv7 not null,
  ledger_id       uuidv7 not null,
  seq             bigint not null,
  transaction_id  uuidv7,
  type            text not null,
  payload         json_obj not null,
  created_at      timestamptz not null default now(),

  unique (organization_id, ledger_id, id),
  unique (organization_id, ledger_id, seq),

  foreign key (organization_id, ledger_id)
    references ledgers (organization_id, id),

  foreign key (organization_id, ledger_id, transaction_id)
    references transactions (organization_id, ledger_id, id),

  constraint ledger_logs_type_valid
    check (type ~ '^[A-Z][A-Z0-9_]{2,63}$'),

  constraint ledger_logs_seq_positive
    check (seq >= 1)
);
-- Authoritative append-only journal, written synchronously.
-- Example types: TRANSACTION_CREATED, TRANSACTION_REVERTED.

create index idx_ledger_logs_transaction
  on ledger_logs (organization_id, ledger_id, transaction_id);
-- Supports looking up logs for one transaction.


-- ---------- ledger_audit_anchors -----------------------------------------

create table ledger_audit_anchors (
  id                  uuidv7 primary key,
  organization_id     uuidv7 not null,
  ledger_id           uuidv7 not null,
  from_log_seq         bigint not null,
  to_log_seq           bigint not null,
  root_hash           sha256_digest not null,
  previous_root_hash  sha256_digest,
  created_at          timestamptz not null default now(),

  unique (organization_id, ledger_id, to_log_seq),

  foreign key (organization_id, ledger_id)
    references ledgers (organization_id, id),

  foreign key (organization_id, ledger_id, from_log_seq)
    references ledger_logs (organization_id, ledger_id, seq),

  foreign key (organization_id, ledger_id, to_log_seq)
    references ledger_logs (organization_id, ledger_id, seq),

  constraint ledger_audit_anchors_range_valid
    check (from_log_seq <= to_log_seq)
);
-- Asynchronous batch anchors for tamper-evident auditing. Hash lengths are
-- enforced by the sha256_digest domain (32 bytes each); previous_root_hash
-- is NULL for the first anchor in a ledger.

create index idx_ledger_audit_anchors_ledger_to_log
  on ledger_audit_anchors (organization_id, ledger_id, to_log_seq desc);
-- Supports finding the latest anchor for a ledger.


-- ---------- outbox_events ------------------------------------------------

create table outbox_events (
  id               bigint generated always as identity primary key,
  organization_id  uuidv7 not null,
  ledger_id        uuidv7 not null,
  aggregate_type   text not null,
  aggregate_id     text not null,
  event_type       event_type not null,
  event_version    integer not null default 1,
  payload          json_obj not null,
  created_at       timestamptz not null default now(),
  published_at     timestamptz,
  publish_attempts integer not null default 0,
  last_error       text,

  foreign key (organization_id, ledger_id)
    references ledgers (organization_id, id),

  constraint outbox_events_aggregate_type_valid
    check (aggregate_type ~ '^[a-z0-9_]+$' and length(aggregate_type) <= 64),

  constraint outbox_events_aggregate_id_length
    check (length(aggregate_id) between 1 and 128),

  constraint outbox_events_event_version_positive
    check (event_version >= 1),

  constraint outbox_events_publish_attempts_nonnegative
    check (publish_attempts >= 0),

  constraint outbox_events_published_after_created
    check (published_at is null or published_at >= created_at),

  constraint outbox_events_published_requires_attempt
    check (published_at is null or publish_attempts >= 1),

  constraint outbox_events_last_error_requires_attempt
    check (last_error is null or publish_attempts > 0)
);
-- Transactional outbox for reliable event publishing.

create index idx_outbox_events_unpublished
  on outbox_events (id)
  where published_at is null;
-- Supports relay worker queries using FOR UPDATE SKIP LOCKED.


-- ---------- idempotency_keys ---------------------------------------------

create table idempotency_keys (
  organization_id uuidv7 not null,
  ledger_id       uuidv7 not null,
  operation       operation_name not null,
  key             text not null,
  method          text not null,
  path            text not null,
  request_hash    sha256_digest not null,
  response_status integer,
  response_body   json_obj,
  state           text not null default 'in_progress',
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  expires_at      timestamptz not null,
  lock_expires_at timestamptz,

  primary key (organization_id, ledger_id, operation, key),

  foreign key (organization_id, ledger_id)
    references ledgers (organization_id, id),

  constraint idempotency_keys_key_length
    check (length(key) between 1 and 256),

  constraint idempotency_keys_method_valid
    check (method in ('POST', 'PUT', 'PATCH', 'DELETE')),

  constraint idempotency_keys_path_valid
    check (path ~ '^/' and length(path) <= 512),

  constraint idempotency_keys_state_valid
    check (state in ('in_progress', 'completed')),

  constraint idempotency_keys_completed_requires_response
    check (
      state <> 'completed'
      or (
        response_status is not null
        and response_body is not null
        and completed_at is not null
      )
    ),

  constraint idempotency_keys_in_progress_requires_lock
    check (
      state <> 'in_progress'
      or lock_expires_at is not null
    ),

  constraint idempotency_keys_response_status_valid
    check (response_status is null or response_status between 100 and 599),

  constraint idempotency_keys_expiry_after_created
    check (expires_at > created_at),

  constraint idempotency_keys_completed_after_created
    check (completed_at is null or completed_at >= created_at)
);
-- Idempotency records scoped by organization, ledger, operation, and key.
-- Concurrency is managed with a lease (state + lock_expires_at) rather than
-- a single advisory-lock transaction; see the idempotency model note in the
-- header for the rationale and its crash-recovery trade-off.

create index idx_idempotency_keys_expires_at
  on idempotency_keys (expires_at);
-- Supports cleanup of expired idempotency records.

create index idx_idempotency_keys_stale_locks
  on idempotency_keys (lock_expires_at)
  where state = 'in_progress';
-- Supports recovery of stale in-progress operations.


-- ---------- Balance overdraft enforcement --------------------------------

create or replace function balances_set_allow_overdraft()
returns trigger
language plpgsql
as $$
begin
  select a.allow_overdraft
    into new.allow_overdraft
  from accounts a
  where a.organization_id = new.organization_id
    and a.ledger_id = new.ledger_id
    and a.address = new.account_address
  for share;

  if not found then
    raise exception 'account not found for balance: org=% ledger=% account=%',
      new.organization_id,
      new.ledger_id,
      new.account_address;
  end if;

  return new;
end;
$$;
-- FOR SHARE blocks a concurrent flag change on the account until this insert
-- commits; otherwise the new balance row could keep a stale flag. (The
-- application role therefore needs UPDATE on accounts, which it has anyway.)
-- Copies the account's overdraft flag into a balance row. The account is
-- guaranteed to exist by the balances -> accounts foreign key; the explicit
-- lookup both materialises the flag and yields a clear error if invariants
-- are ever violated.

create trigger balances_set_allow_overdraft_before_insert
before insert on balances
for each row execute function balances_set_allow_overdraft();
-- Runs only on INSERT. Deliberately NOT fired on balance updates: re-deriving
-- the flag on every posting would add a lookup against accounts to the
-- hottest write path. Existing rows stay in sync via
-- accounts_sync_allow_overdraft.

create or replace function balances_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
-- Refreshes updated_at whenever the balance value changes.

create trigger balances_touch_updated_at_before_update
before update of balance
on balances
for each row execute function balances_touch_updated_at();
-- Keeps updated_at current for balance mutations.

create or replace function accounts_sync_allow_overdraft()
returns trigger
language plpgsql
as $$
begin
  update balances b
     set allow_overdraft = new.allow_overdraft
   where b.organization_id = new.organization_id
     and b.ledger_id = new.ledger_id
     and b.account_address = new.address;

  return new;
end;
$$;
-- Propagates account overdraft changes to existing balances.

create trigger accounts_sync_allow_overdraft_after_update
after update of allow_overdraft
on accounts
for each row
when (old.allow_overdraft is distinct from new.allow_overdraft)
execute function accounts_sync_allow_overdraft();
-- Keeps balances consistent with accounts; fires only when the flag changes.


-- ---------- Append-only protection ---------------------------------------

create or replace function prevent_row_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows are append-only', tg_table_name;
end;
$$;
-- Generic guard for append-only tables.

create trigger postings_no_update
before update on postings
for each row execute function prevent_row_mutation();
-- Postings cannot be updated.

create trigger postings_no_delete
before delete on postings
for each row execute function prevent_row_mutation();
-- Postings cannot be deleted.

create trigger ledger_logs_no_update
before update on ledger_logs
for each row execute function prevent_row_mutation();
-- Ledger logs cannot be updated.

create trigger ledger_logs_no_delete
before delete on ledger_logs
for each row execute function prevent_row_mutation();
-- Ledger logs cannot be deleted.

create trigger ledger_audit_anchors_no_update
before update on ledger_audit_anchors
for each row execute function prevent_row_mutation();
-- Audit anchors cannot be updated.

create trigger ledger_audit_anchors_no_delete
before delete on ledger_audit_anchors
for each row execute function prevent_row_mutation();
-- Audit anchors cannot be deleted.

create or replace function prevent_row_deletion()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name;
end;
$$;
-- Generic deletion guard for tables that may be updated but not deleted.

create trigger transactions_no_delete
before delete on transactions
for each row execute function prevent_row_deletion();
-- Transactions cannot be deleted; corrections must be new transactions.


-- ---------- Ledger log sequence ------------------------------------------

create or replace function ledger_logs_assign_seq()
returns trigger
language plpgsql
as $$
begin
  -- Bumping the counter takes a row lock on the ledger that is held until
  -- this transaction ends. Two log writers on one ledger therefore commit in
  -- seq order, and a rollback also rolls the counter back (no gaps).
  update ledgers l
     set last_log_seq = l.last_log_seq + 1
   where l.organization_id = new.organization_id
     and l.id = new.ledger_id
  returning l.last_log_seq into new.seq;

  if not found then
    raise exception 'ledger not found for log: org=% ledger=%',
      new.organization_id,
      new.ledger_id;
  end if;

  return new;
end;
$$;
-- Assigns ledger_logs.seq. Any value supplied by the client is overwritten,
-- so every writer gets the same guarantee. NOT NULL is checked after BEFORE
-- triggers, so callers can simply omit seq.

create trigger ledger_logs_assign_seq_before_insert
before insert on ledger_logs
for each row execute function ledger_logs_assign_seq();
-- Runs before every log insert.


-- ---------- TRUNCATE protection ------------------------------------------
-- Row-level DELETE triggers do NOT fire on TRUNCATE, so each protected table
-- needs its own statement-level trigger.

create trigger postings_no_truncate
before truncate on postings
for each statement execute function prevent_row_mutation();

create trigger ledger_logs_no_truncate
before truncate on ledger_logs
for each statement execute function prevent_row_mutation();

create trigger ledger_audit_anchors_no_truncate
before truncate on ledger_audit_anchors
for each statement execute function prevent_row_mutation();

create trigger transactions_no_truncate
before truncate on transactions
for each statement execute function prevent_row_deletion();
-- TRUNCATE is blocked on every append-only or delete-protected table.


-- ---------- Audit anchor chain enforcement -------------------------------

create or replace function ledger_audit_anchors_enforce_chain()
returns trigger
language plpgsql
as $$
declare
  v_lock_key         bigint;
  v_prev_root_hash   bytea;
  v_prev_to_log_seq  bigint;
begin
  -- Serialize anchor insertion per ledger. A 64-bit key (hashtextextended)
  -- is used instead of the 32-bit hashtext so that unrelated ledgers are
  -- negligibly likely to collide on the same advisory lock (collisions would
  -- cause false serialization, not corruption).
  v_lock_key := hashtextextended(
    'audit_anchor:' || new.organization_id::text || ':' || new.ledger_id::text,
    0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  select a.root_hash, a.to_log_seq
    into v_prev_root_hash, v_prev_to_log_seq
  from ledger_audit_anchors a
  where a.organization_id = new.organization_id
    and a.ledger_id = new.ledger_id
  order by a.to_log_seq desc
  limit 1;

  if not found then
    if new.previous_root_hash is not null then
      raise exception 'first audit anchor for ledger must have null previous_root_hash';
    end if;
    if new.from_log_seq <> 1 then
      raise exception 'first audit anchor for ledger must start at log seq 1';
    end if;
  else
    if new.previous_root_hash is distinct from v_prev_root_hash then
      raise exception 'audit anchor previous_root_hash does not match previous anchor';
    end if;
    -- ledger_logs.seq is gap-free and follows commit order, so the next
    -- anchor must start exactly after the previous one. No scan needed.
    if new.from_log_seq <> v_prev_to_log_seq + 1 then
      raise exception 'audit anchor from_log_seq must equal previous to_log_seq + 1';
    end if;
  end if;

  return new;
end;
$$;
-- Enforces sequential, gap-free audit anchoring per ledger.

create trigger ledger_audit_anchors_enforce_chain_before_insert
before insert on ledger_audit_anchors
for each row execute function ledger_audit_anchors_enforce_chain();
-- Validates audit anchor chaining before insert.


-- ---------- Row-level security -------------------------------------------

create or replace function current_organization_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('daric.organization_id', true), '')::uuid
$$;
-- Tenant boundary used by every row-level-security policy below. The
-- application must run SET LOCAL daric.organization_id = '<uuid>' at the
-- start of each transaction. Returns NULL when the setting is absent, which
-- matches no row, so access fails closed.

alter table ledgers               enable row level security;
alter table accounts              enable row level security;
alter table transactions          enable row level security;
alter table postings              enable row level security;
alter table balances              enable row level security;
alter table ledger_logs           enable row level security;
alter table ledger_audit_anchors  enable row level security;
alter table outbox_events         enable row level security;
alter table idempotency_keys      enable row level security;
-- RLS is enabled but NOT forced, so the table owner (used by migrations)
-- still bypasses it. Application connections must use a least-privilege,
-- non-owner role for these policies to take effect. Cross-tenant background
-- workers (e.g. the outbox relay) must either run as a role with BYPASSRLS
-- or set daric.organization_id per unit of work; per-ledger workers (e.g.
-- the audit-anchor worker) simply set the tenant.

create policy ledgers_tenant_isolation on ledgers
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy accounts_tenant_isolation on accounts
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy transactions_tenant_isolation on transactions
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy postings_tenant_isolation on postings
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy balances_tenant_isolation on balances
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy ledger_logs_tenant_isolation on ledger_logs
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy ledger_audit_anchors_tenant_isolation on ledger_audit_anchors
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy outbox_events_tenant_isolation on outbox_events
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

create policy idempotency_keys_tenant_isolation on idempotency_keys
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());
-- Uniform tenant-isolation policies: USING filters reads/updates/deletes,
-- WITH CHECK prevents writing a row for another tenant.


-- ---------- Column comments ----------------------------------------------

comment on column ledgers.organization_id is
  'Opaque tenant reference owned by the Identity service.';

comment on column accounts.organization_id is
  'Opaque tenant reference owned by the Identity service.';

comment on column transactions.organization_id is
  'Opaque tenant reference owned by the Identity service.';

comment on column transactions.reference is
  'Optional external business identifier, unique per ledger.';

comment on column transactions.posted_at is
  'Business timestamp of the transaction.';

comment on column postings.amount is
  'Positive integer minor units.';

comment on column balances.balance is
  'Signed integer minor units. Negative allowed only when allow_overdraft is true.';

comment on column balances.allow_overdraft is
  'Denormalised copy of accounts.allow_overdraft, kept in sync by triggers.';

comment on column ledger_logs.type is
  'Synchronous journal mutation type, e.g. TRANSACTION_CREATED.';

comment on column ledger_audit_anchors.root_hash is
  'SHA-256 batch root hash (32 bytes) for anchored ledger logs.';

comment on column ledger_audit_anchors.previous_root_hash is
  'Root hash of the previous anchor; NULL for the first anchor in a ledger.';

comment on column ledger_audit_anchors.from_log_seq is
  'First ledger_logs.seq covered by this anchor (inclusive).';

comment on column ledger_audit_anchors.to_log_seq is
  'Last ledger_logs.seq covered by this anchor (inclusive).';

comment on column outbox_events.aggregate_type is
  'Aggregate type name, e.g. transaction, account, ledger.';

comment on column idempotency_keys.operation is
  'Stable API operation name, e.g. transactions.create.';

comment on column idempotency_keys.request_hash is
  'SHA-256 digest (32 bytes) of the canonical request, used to detect key reuse with a changed payload.';

comment on column idempotency_keys.lock_expires_at is
  'Lease expiry for in-progress operations; NULL once completed.';