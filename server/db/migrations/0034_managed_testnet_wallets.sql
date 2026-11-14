-- Custodial testnet wallets. Ciphertext is authenticated to the profile/account/network.
alter table resident_profiles add column wallet_kind text not null default 'browser'
 check(wallet_kind in ('browser','embedded','external'));
update resident_profiles set wallet_kind='external' where wallet_linked;
create table managed_wallets (
 profile_id uuid primary key references resident_profiles(id),
 account_id text not null unique check(length(account_id) between 2 and 64),
 network_id text not null check(network_id='testnet'),
 public_key text not null unique check(public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 encrypted_key text not null check(length(encrypted_key) between 100 and 1000),
 stage text not null default 'creating_account' check(stage in ('creating_account','registering','claiming','ready')),
 registration_request uuid not null unique,
 starter_request uuid not null unique,
 last_error_code text,
 next_attempt_at timestamptz not null default now(),
 attempt_count int not null default 0 check(attempt_count>=0),
 faucet_requested_at timestamptz,
 faucet_attempts int not null default 0 check(faucet_attempts between 0 and 3),
 lease_token uuid,
 lease_until timestamptz,
 last_nonce numeric(20,0) not null default 0 check(last_nonce between 0 and 18446744073709551615),
 signing_token uuid,
 signing_until timestamptz,
 created_at timestamptz not null default now(),
 ready_at timestamptz,
 check((stage='ready')=(ready_at is not null))
);
create index managed_wallet_due_idx on managed_wallets(next_attempt_at,profile_id) where stage<>'ready';
create table managed_wallet_transactions (
 id uuid primary key,
 profile_id uuid not null references managed_wallets(profile_id),
 request_hash text not null check(length(request_hash)=64),
 method text not null check(length(method) between 1 and 40),
 args jsonb not null check(jsonb_typeof(args)='object'),
 signed_transaction text not null check(length(signed_transaction) between 100 and 30000),
 tx_hash text not null unique check(length(tx_hash) between 43 and 44),
 nonce numeric(20,0) not null check(nonce between 1 and 18446744073709551615),
 state text not null default 'pending' check(state in ('pending','confirmed','rejected')),
 created_at timestamptz not null default now(),
 broadcast_at timestamptz,
 checked_at timestamptz
);
create unique index managed_wallet_one_pending_idx on managed_wallet_transactions(profile_id) where state='pending';
create index managed_wallet_history_idx on managed_wallet_transactions(profile_id,created_at desc,id);
create table managed_wallet_audit (
 id bigserial primary key,
 profile_id uuid not null references managed_wallets(profile_id),
 action text not null check(action in ('allocated','faucet_requested','created','registered','starter_confirmed','backup_exported')),
 created_at timestamptz not null default now()
);
create index managed_wallet_audit_profile_idx on managed_wallet_audit(profile_id,id);

create index managed_wallet_sponsor_budget_idx on managed_wallet_audit(created_at) where action='faucet_requested';
