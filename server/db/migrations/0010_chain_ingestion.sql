-- QC-0307: restart-safe chain cursor and dead-letter storage.

create table if not exists chain_cursors (
  network_id           text not null,
  contract_id          text not null,
  source               text not null,
  next_cursor          text not null,
  last_finalized_block bigint,
  last_finalized_hash  text,
  version              bigint not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (network_id, contract_id, source),
  check (network_id <> ''),
  check (contract_id <> ''),
  check (source <> ''),
  check (next_cursor <> '')
);

create table if not exists chain_event_failures (
  id             bigserial primary key,
  network_id     text not null,
  contract_id    text not null,
  receipt_id     text,
  event_index    integer,
  payload        jsonb,
  error_code     text not null,
  error_message  text not null,
  attempt_count  integer not null default 1,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  ignored_reason text,
  ignored_at     timestamptz,
  unique (network_id, contract_id, receipt_id, event_index),
  check (error_code <> '')
);

create index if not exists chain_event_failures_seen_idx
  on chain_event_failures (network_id, contract_id, last_seen_at desc);
