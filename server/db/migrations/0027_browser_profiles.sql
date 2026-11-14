-- Browser profiles are server-owned identities, separate from chain mirrors.
create table browser_devices (
  token_hash text primary key check (length(token_hash)=64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table resident_profiles (
  id uuid primary key,
  device_hash text not null references browser_devices(token_hash),
  username text not null check (username ~ '^[a-z][a-z0-9_]{2,23}$'),
  first_name text not null check (length(first_name) between 1 and 40),
  account_id text not null unique,
  wallet_linked boolean not null default false,
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index resident_profiles_username_idx on resident_profiles(lower(username));
create index resident_profiles_device_idx on resident_profiles(device_hash,created_at);
alter table auth_sessions add column session_kind text not null default 'wallet' check (session_kind in ('wallet','browser'));
create table browser_profile_access (
  device_hash text not null references browser_devices(token_hash),
  profile_id uuid not null references resident_profiles(id),
  primary key(device_hash,profile_id)
);
