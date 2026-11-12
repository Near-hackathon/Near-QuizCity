-- QC-0202: one ledger row per emitted contract event, not one row per tx hash.

alter table transactions
  add column if not exists network_id      text,
  add column if not exists contract_id     text,
  add column if not exists block_hash      text,
  add column if not exists receipt_id      text,
  add column if not exists event_index     integer,
  add column if not exists event_name      text,
  add column if not exists event_version   text,
  add column if not exists entity_type     text,
  add column if not exists entity_id       text,
  add column if not exists payload         jsonb not null default '{}'::jsonb,
  add column if not exists chain_timestamp timestamptz,
  add column if not exists observed_at     timestamptz;

-- Backfill pre-migration rows so every row has a stable (network, receipt,
-- event index) identity and can be reproduced without guessing.
update transactions set
  network_id      = coalesce(network_id, 'legacy'),
  contract_id     = coalesce(contract_id, 'legacy'),
  receipt_id      = coalesce(receipt_id, 'legacy:' || seq::text),
  event_index     = coalesce(event_index, 0),
  event_name      = coalesce(event_name, kind),
  event_version   = coalesce(event_version, '1.0.0'),
  entity_type     = coalesce(entity_type, case kind
                      when 'property_sale' then 'property'
                      when 'business_permit' then 'business'
                      when 'service_payment' then 'business'
                      when 'job_reward' then 'job'
                      when 'quiz_reward' then 'quiz_attempt'
                      when 'starter_allowance' then 'wallet'
                      else 'unknown' end),
  entity_id       = coalesce(entity_id, reference),
  observed_at     = coalesce(observed_at, created_at)
where network_id is null or receipt_id is null or event_index is null;

-- Issuance and burn use NULL wallets; keep the old pseudo-wallet strings out
-- of the canonical ledger. Drop NOT NULL first so the backfill can write NULL.
alter table transactions
  alter column wallet_from drop not null,
  alter column wallet_to drop not null;

update transactions set wallet_from = null where wallet_from = 'system:mint';
update transactions set wallet_to = null where wallet_to = 'system:burn';

alter table transactions
  alter column network_id set not null,
  alter column contract_id set not null,
  alter column receipt_id set not null,
  alter column event_index set not null,
  alter column event_name set not null,
  alter column event_version set not null,
  alter column amount type numeric(39,0),
  alter column observed_at set default now(),
  alter column observed_at set not null;

-- The old unique tx_hash index forbids multiple events from one transaction.
drop index if exists transactions_tx_hash_idx;
create index if not exists transactions_tx_hash_lookup_idx on transactions (tx_hash);
create unique index if not exists transactions_receipt_event_idx
  on transactions (network_id, receipt_id, event_index);

create index if not exists transactions_wallet_from_idx on transactions (wallet_from, seq desc);
create index if not exists transactions_wallet_to_idx on transactions (wallet_to, seq desc);
create index if not exists transactions_entity_idx on transactions (entity_type, entity_id, seq desc);
create index if not exists transactions_block_height_idx on transactions (block_height);
create index if not exists transactions_event_name_idx on transactions (event_name, seq desc);

-- The reconciliation inbox had the same one-receipt-per-row limitation.
alter table chain_events
  add column if not exists network_id    text,
  add column if not exists contract_id   text,
  add column if not exists event_index   integer,
  add column if not exists event_name    text,
  add column if not exists block_height  bigint,
  add column if not exists block_hash    text,
  add column if not exists tx_hash       text,
  add column if not exists observed_at   timestamptz;

update chain_events set
  network_id  = coalesce(network_id, 'legacy'),
  contract_id = coalesce(contract_id, 'legacy'),
  event_index = coalesce(event_index, 0),
  event_name  = coalesce(event_name, event),
  observed_at = coalesce(observed_at, received_at)
where network_id is null or event_index is null;

alter table chain_events
  alter column network_id set not null,
  alter column contract_id set not null,
  alter column event_index set not null,
  alter column event_name set not null,
  alter column observed_at set default now(),
  alter column observed_at set not null;

alter table chain_events drop constraint if exists chain_events_pkey;
create unique index if not exists chain_events_receipt_event_idx
  on chain_events (network_id, receipt_id, event_index);
