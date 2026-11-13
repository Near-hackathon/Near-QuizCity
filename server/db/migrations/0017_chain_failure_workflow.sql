-- R3-06: blocking dead-letter workflow with audited retry/ignore.

alter table chain_event_failures
  add column if not exists block_height text,
  add column if not exists ignored_by text,
  add column if not exists resolved_at timestamptz,
  add column if not exists retry_count integer not null default 0;

alter table chain_event_failures
  add constraint chain_event_failures_block_height_check check (
    block_height is null or block_height ~ '^(0|[1-9][0-9]*)$'
  ),
  add constraint chain_event_failures_retry_count_check check (retry_count >= 0);

create index if not exists chain_event_failures_blocking_idx
  on chain_event_failures (network_id, contract_id, last_seen_at)
  where ignored_at is null and resolved_at is null;
