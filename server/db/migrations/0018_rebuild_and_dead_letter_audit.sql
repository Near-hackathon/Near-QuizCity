-- Phase 3 final fixes: dead-letter retry provenance and rebuild audit history.

alter table chain_event_failures
  add column if not exists source text,
  add column if not exists retry_requested_at timestamptz,
  add column if not exists resolved_by text;

-- Best-effort backfill for local databases that only have one cursor source.
update chain_event_failures f
set source = c.source
from chain_cursors c
where f.source is null
  and c.network_id = f.network_id
  and c.contract_id = f.contract_id;

alter table chain_event_failures
  add constraint chain_event_failures_source_check check (
    source is null or (source <> '' and length(source) <= 128)
  ),
  add constraint chain_event_failures_resolved_by_check check (
    resolved_by is null or (resolved_by <> '' and length(resolved_by) <= 128)
  );

create table if not exists rebuild_runs (
  id                    bigserial primary key,
  network_id            text not null,
  contract_id           text not null,
  source                text not null,
  status                text not null check (status in ('running', 'success', 'failed')),
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  start_cursor          text not null,
  final_cursor          text,
  last_finalized_block  text,
  last_finalized_hash   text,
  pages                 integer not null default 0,
  events_staged         integer not null default 0,
  events_applied        integer not null default 0,
  replays               integer not null default 0,
  property_count        integer,
  business_count        integer,
  wallet_count          integer,
  canonical_supply      numeric(39,0),
  mirrored_wallet_sum   numeric(39,0),
  difference            numeric(39,0),
  cleared_failures      integer,
  error_message         text
);

create index if not exists rebuild_runs_started_idx
  on rebuild_runs (network_id, contract_id, started_at desc);
