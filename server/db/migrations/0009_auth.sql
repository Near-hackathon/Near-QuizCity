-- QC-0303: opaque sessions, one-time login nonces, and explicit roles.

create table if not exists auth_nonces (
  id          bigserial primary key,
  account_id  text not null,
  nonce_hash  text not null unique,
  domain      text not null,
  network_id  text not null,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  check (account_id <> ''),
  check (nonce_hash <> ''),
  check (domain <> ''),
  check (network_id <> '')
);
create index if not exists auth_nonces_account_idx on auth_nonces (account_id, issued_at desc);
create index if not exists auth_nonces_expiry_idx on auth_nonces (expires_at);

create table if not exists auth_sessions (
  token_hash    text primary key,
  account_id    text not null,
  csrf_hash     text not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  check (token_hash <> ''),
  check (account_id <> ''),
  check (csrf_hash <> '')
);
create index if not exists auth_sessions_account_idx on auth_sessions (account_id, expires_at desc);

create table if not exists account_roles (
  account_id text not null,
  role       text not null check (role in ('player', 'operator', 'admin')),
  created_at timestamptz not null default now(),
  primary key (account_id, role),
  check (account_id <> '')
);
