-- Server-scored two-player knowledge matches. QC stays in existing contract escrows.
create table quiz_matches (
 id uuid primary key,
 request_id uuid not null unique,
 host_account text not null references players(account_id),
 invite_code text not null unique check(invite_code ~ '^[A-F0-9]{10}$'),
 stake numeric(39,0) not null check(stake between 20 and 1000),
 venue_fee numeric(39,0) not null check(venue_fee=ceil(stake*0.05)),
 gas_fee numeric(39,0) not null check(gas_fee between 0 and 1),
 venue_wallet text not null,
 gas_wallet text not null,
 curriculum_version text not null,
 questions jsonb not null check(jsonb_typeof(questions)='array' and jsonb_array_length(questions)=5),
 state text not null default 'waiting' check(state in ('waiting','countdown','playing','settling','completed','refunded')),
 outcome text check(outcome in ('win','tie','cancelled')),
 winner_account text references players(account_id),
 next_tick_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 join_expires_at timestamptz not null,
 starts_at timestamptz,
 ends_at timestamptz,
 check(join_expires_at>created_at),
 check(coalesce(outcome='win',false)=(winner_account is not null)),
 check((starts_at is null)=(ends_at is null)),
 check(ends_at is null or ends_at>starts_at),
 check((state in ('settling','completed','refunded'))=(outcome is not null))
);
create index quiz_matches_live_idx on quiz_matches(next_tick_at,id) where state in ('waiting','countdown','playing','settling');
create table quiz_match_players (
 id uuid primary key,
 match_id uuid not null references quiz_matches(id),
 request_id uuid not null unique,
 account_id text not null references players(account_id),
 seat smallint not null check(seat in (0,1)),
 escrow_id uuid not null unique,
 operation_id uuid not null unique references city_operations(id),
 funded_at timestamptz,
 submitted_at timestamptz,
 answers jsonb check(answers is null or jsonb_typeof(answers)='object'),
 answer_hash text check(answer_hash is null or length(answer_hash)=64),
 score smallint check(score between 0 and 5),
 created_at timestamptz not null default now(),
 unique(match_id,account_id), unique(match_id,seat), unique(id,match_id),
 check((submitted_at is null)=(score is null))
);
create index quiz_match_players_account_idx on quiz_match_players(account_id,created_at desc,id);
alter table quiz_matches add constraint quiz_match_winner_member foreign key(id,winner_account) references quiz_match_players(match_id,account_id);
create table quiz_match_transfers (
 id uuid primary key,
 match_id uuid not null references quiz_matches(id),
 player_id uuid not null references quiz_match_players(id),
 kind text not null check(kind in ('stake','venue','gas','refund')),
 amount numeric(39,0) not null check(amount>0 and amount<=10000),
 recipient_wallet text not null,
 operation_id uuid not null unique references city_operations(id),
 state text not null default 'queued' check(state in ('queued','submitting','unknown','confirmed','rejected')),
 lease_token uuid,
 lease_until timestamptz,
 next_check_at timestamptz not null default now(),
 last_error_code text,
 foreign key(player_id,match_id) references quiz_match_players(id,match_id),
 unique(player_id,kind)
);
create index quiz_match_transfer_due_idx on quiz_match_transfers(next_check_at,id) where state in ('queued','submitting','unknown');
