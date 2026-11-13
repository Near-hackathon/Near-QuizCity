-- QC-0302: a verified transaction can be used for exactly one command/entity.

create table if not exists transaction_consumptions (
  network_id    text not null,
  contract_id   text not null,
  tx_hash       text not null,
  command_type  text not null,
  entity_type   text not null,
  entity_id     text not null,
  signer_id     text not null,
  receipt_id    text not null,
  event_index   integer not null,
  created_at    timestamptz not null default now(),
  primary key (network_id, contract_id, tx_hash),
  check (network_id <> ''),
  check (contract_id <> ''),
  check (tx_hash <> ''),
  check (command_type <> ''),
  check (entity_type <> ''),
  check (entity_id <> ''),
  check (signer_id <> ''),
  check (receipt_id <> ''),
  check (event_index >= 0)
);

create index if not exists transaction_consumptions_entity_idx
  on transaction_consumptions (command_type, entity_type, entity_id);
