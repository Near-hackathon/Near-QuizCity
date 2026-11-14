-- Existing invite rooms remain private. Discovery never exposes their codes or questions.
alter table quiz_matches add column visibility text not null default 'private'
 check(visibility in ('private','public'));
alter table quiz_matches add constraint quiz_matches_public_policy_check
 check(visibility='private' or fee_policy='deducted-2-v2');
alter table quiz_matches add constraint quiz_matches_id_stake_unique unique(id,stake);
create index quiz_matches_public_pool_idx on quiz_matches(stake,created_at,id)
 include(join_expires_at,host_account)
 where visibility='public' and state='waiting' and outcome is null;
create table quiz_match_searches (
 request_id uuid primary key,
 account_id text not null references players(account_id),
 match_id uuid not null,
 stake numeric(39,0) not null check(stake between 50 and 1000 and mod(stake,50)=0),
 created_at timestamptz not null default now(),
 foreign key(match_id,account_id) references quiz_match_players(match_id,account_id),
 foreign key(match_id,stake) references quiz_matches(id,stake)
);
create index quiz_match_searches_account_idx on quiz_match_searches(account_id,created_at);
