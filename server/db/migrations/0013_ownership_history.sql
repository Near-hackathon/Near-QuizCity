-- QC-0306: immutable asset ownership history for property and business transfers.

create table if not exists asset_ownership_history (
  network_id    text not null,
  contract_id   text not null,
  receipt_id    text not null,
  event_index   integer not null,
  asset_type    text not null check (asset_type in ('property', 'business')),
  asset_id      text not null,
  previous_owner text not null,
  new_owner     text not null,
  reference     text,
  block_height  bigint,
  block_hash    text,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (network_id, contract_id, receipt_id, event_index),
  check (network_id <> ''),
  check (contract_id <> ''),
  check (receipt_id <> ''),
  check (asset_id <> ''),
  check (previous_owner <> ''),
  check (new_owner <> ''),
  check (previous_owner <> new_owner)
);

create index if not exists asset_ownership_history_asset_idx
  on asset_ownership_history (asset_type, asset_id, block_height, event_index);
create index if not exists asset_ownership_history_new_owner_idx
  on asset_ownership_history (new_owner);
