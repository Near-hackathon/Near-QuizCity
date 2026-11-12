-- QUIZ CITY read-model mirror. The NEAR contract is the source of truth for
-- QC balances and asset ownership; these tables are rebuildable from chain.

create table if not exists players (
  account_id     text primary key,
  username       text not null unique,
  reputation     integer not null default 0,
  created_at     timestamptz not null default now()
);

-- Mirror of contract logical wallets (player:*, npc:*, gov:*, biz:*).
-- Never write balances here without a confirmed chain tx.
create table if not exists wallets (
  wallet_id      text primary key,
  owner_type     text not null check (owner_type in ('player','npc','gov','business')),
  owner_id       text not null,
  balance        numeric(20,0) not null default 0,
  wallet_type    text not null default 'logical',
  updated_at     timestamptz not null default now(),
  last_tx_hash   text
);

create table if not exists transactions (
  seq            bigserial primary key,
  tx_hash        text,
  wallet_from    text not null,
  wallet_to      text not null,
  amount         numeric(20,0) not null,
  kind           text not null,
  reference      text,
  block_height   bigint,
  created_at     timestamptz not null default now()
);
create index if not exists transactions_created_at_idx on transactions (created_at desc);
create index if not exists transactions_reference_idx on transactions (reference);

create table if not exists properties (
  id             bigint primary key,
  district       text not null,
  x              integer not null,
  y              integer not null,
  owner_wallet   text not null,
  property_type  text not null,
  price          numeric(20,0) not null default 0,
  for_sale       boolean not null default false,
  transfer_count bigint not null default 0,
  updated_at     timestamptz not null default now()
);
create index if not exists properties_owner_idx on properties (owner_wallet);

create table if not exists businesses (
  id              bigint primary key,
  name            text not null,
  owner_account   text not null,
  property_id     bigint not null references properties (id),
  treasury_wallet text not null,
  category        text not null default 'quiz_centre',
  revenue_total   numeric(20,0) not null default 0,
  status          text not null default 'open',
  created_at      timestamptz not null default now()
);

create table if not exists jobs (
  id             text primary key,
  employer_wallet text not null,
  employee_account text,
  title          text not null,
  description    text not null default '',
  payment        numeric(20,0) not null,
  status         text not null default 'open'
                 check (status in ('open','accepted','completed','paid','cancelled')),
  deadline       timestamptz,
  reference      text not null unique,
  chain_tx       text,
  created_at     timestamptz not null default now()
);
create index if not exists jobs_status_idx on jobs (status);

create table if not exists quiz_questions (
  id             text primary key,
  category       text not null,
  difficulty     text not null default 'easy' check (difficulty in ('easy','medium','hard')),
  question       text not null,
  options        jsonb not null,
  correct_index  integer not null,
  source         text not null default 'curated',
  verification_status text not null default 'verified'
);

create table if not exists quizzes (
  id             text primary key,
  venue_business_id bigint references businesses (id),
  title          text not null,
  reward_pool    numeric(20,0) not null default 0,
  entry_fee      numeric(20,0) not null default 0,
  status         text not null default 'draft'
                 check (status in ('draft','live','closed')),
  created_at     timestamptz not null default now()
);

create table if not exists quiz_attempts (
  id             text primary key,
  quiz_id        text not null references quizzes (id),
  player_account text not null,
  score          integer not null default 0,
  total          integer not null default 0,
  reward_paid    numeric(20,0) not null default 0,
  reward_tx      text,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  unique (quiz_id, player_account, started_at)
);

create table if not exists market_listings (
  id             text primary key,
  seller_wallet  text not null,
  asset_type     text not null check (asset_type in ('property','business','item')),
  asset_id       text not null,
  asking_price   numeric(20,0) not null,
  status         text not null default 'active'
                 check (status in ('active','sold','cancelled')),
  created_at     timestamptz not null default now()
);

create table if not exists npc_state (
  npc_id         text primary key,
  wallet_id      text not null,
  archetype      text not null,
  budget         numeric(20,0) not null default 0,
  state          jsonb not null default '{}'::jsonb,
  last_tick_at   timestamptz
);

create table if not exists economy_snapshots (
  id             bigserial primary key,
  taken_at       timestamptz not null default now(),
  total_issued   numeric(20,0) not null default 0,
  total_burned   numeric(20,0) not null default 0,
  tx_count       bigint not null default 0,
  players        integer not null default 0,
  properties     integer not null default 0,
  businesses     integer not null default 0,
  payload        jsonb not null default '{}'::jsonb
);

-- Confirmed chain events applied to the mirror, for idempotent reconciliation.
create table if not exists chain_events (
  receipt_id     text primary key,
  tx_hash        text,
  event          text not null,
  payload        jsonb not null,
  applied        boolean not null default false,
  received_at    timestamptz not null default now()
);

alter table quiz_questions add column if not exists quiz_id text references quizzes (id);
create unique index if not exists transactions_tx_hash_idx on transactions (tx_hash) where tx_hash is not null;
