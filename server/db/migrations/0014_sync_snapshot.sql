-- QC-0308: authoritative snapshot merge, archival, and supply reconciliation.

alter table properties
  add column if not exists active boolean not null default true,
  add column if not exists archived_at timestamptz;
alter table businesses
  add column if not exists active boolean not null default true,
  add column if not exists archived_at timestamptz;
alter table wallets
  add column if not exists active boolean not null default true,
  add column if not exists archived_at timestamptz;

create index if not exists properties_active_idx on properties (active);
create index if not exists businesses_active_idx on businesses (active);
create index if not exists wallets_active_idx on wallets (active);

alter table economy_snapshots
  add column if not exists fingerprint text;
create unique index if not exists economy_snapshots_fingerprint_idx
  on economy_snapshots (fingerprint);

create table if not exists sync_runs (
  id                   bigserial primary key,
  network_id           text not null,
  contract_id          text not null,
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  status               text not null check (status in ('running', 'success', 'failed', 'skipped')),
  expected_properties  integer,
  expected_businesses  integer,
  expected_wallets     integer,
  actual_properties    integer,
  actual_businesses    integer,
  actual_wallets       integer,
  canonical_supply     numeric(39,0),
  mirrored_wallet_sum  numeric(39,0),
  error_message        text,
  check (network_id <> ''),
  check (contract_id <> '')
);
create index if not exists sync_runs_started_idx on sync_runs (started_at desc);
