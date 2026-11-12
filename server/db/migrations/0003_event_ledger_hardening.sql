-- QC-0202 hardening: keep the raw inbox and normalized projection constrained.

alter table chain_events
  add column if not exists event_version text;

update chain_events set event_version = '1.0.0' where event_version is null;

alter table chain_events
  alter column event_version set not null;

alter table transactions
  add constraint transactions_event_index_check check (event_index >= 0),
  add constraint transactions_amount_range_check check (
    amount >= 0 and amount <= 340282366920938463463374607431768211455
  ),
  add constraint transactions_identity_text_check check (
    network_id <> '' and contract_id <> '' and receipt_id <> '' and
    event_name <> '' and event_version <> ''
  ),
  add constraint transactions_wallet_text_check check (
    (wallet_from is null or wallet_from <> '') and (wallet_to is null or wallet_to <> '')
  ),
  add constraint transactions_entity_text_check check (
    entity_id is null or entity_id <> ''
  );

alter table chain_events
  add constraint chain_events_event_index_check check (event_index >= 0),
  add constraint chain_events_identity_text_check check (
    network_id <> '' and contract_id <> '' and receipt_id <> '' and
    event_name <> '' and event_version <> ''
  );

create index if not exists transactions_observed_at_idx on transactions (observed_at desc);
create index if not exists transactions_chain_timestamp_idx on transactions (chain_timestamp desc);
create index if not exists chain_events_observed_at_idx on chain_events (observed_at desc);
create index if not exists chain_events_applied_idx on chain_events (applied);
