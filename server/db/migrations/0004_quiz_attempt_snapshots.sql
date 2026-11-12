-- QC-0203: immutable quiz attempt snapshots and one daily reward reservation.

alter table quiz_attempts
  add column if not exists status text,
  add column if not exists pass_score integer,
  add column if not exists reward_amount numeric(39,0),
  add column if not exists expires_at timestamptz,
  add column if not exists reward_day date,
  add column if not exists submitted_at timestamptz,
  add column if not exists rewarded_at timestamptz,
  add column if not exists payment_reference text,
  add column if not exists last_error text;

update quiz_attempts set
  status = case
    when completed_at is not null and reward_paid > 0 then 'rewarded'
    when completed_at is not null then 'submitted'
    else 'started'
  end,
  pass_score = coalesce(pass_score, 6),
  reward_amount = coalesce(reward_amount, reward_paid),
  expires_at = coalesce(expires_at, started_at + interval '10 minutes'),
  reward_day = coalesce(reward_day, (started_at at time zone 'UTC')::date),
  submitted_at = coalesce(submitted_at, completed_at),
  rewarded_at = coalesce(rewarded_at, case when reward_paid > 0 then completed_at else null end),
  payment_reference = coalesce(payment_reference, case when reward_tx is not null then 'quiz:' || id else null end)
where status is null or pass_score is null or reward_amount is null
   or expires_at is null or reward_day is null;

alter table quiz_attempts
  alter column status set not null,
  alter column pass_score set not null,
  alter column reward_amount set not null,
  alter column expires_at set not null,
  alter column reward_day set not null;

alter table quiz_attempts
  add constraint quiz_attempts_status_check check (
    status in ('started', 'submitted', 'reward_pending', 'rewarded', 'failed', 'expired')
  );

create index if not exists quiz_attempts_status_idx on quiz_attempts (status);
create index if not exists quiz_attempts_reward_day_idx on quiz_attempts (player_account, reward_day);

create table if not exists quiz_attempt_questions (
  attempt_id    text not null references quiz_attempts (id) on delete cascade,
  position      integer not null,
  question_id   text not null,
  question      text not null,
  options       jsonb not null,
  correct_index integer not null,
  category      text,
  difficulty    text,
  source        text,
  primary key (attempt_id, position),
  unique (attempt_id, question_id),
  check (position >= 0),
  check (correct_index >= 0)
);

create table if not exists quiz_reward_claims (
  id             bigserial primary key,
  player_account text not null,
  reward_day     date not null,
  attempt_id     text not null unique references quiz_attempts (id) on delete cascade,
  status         text not null default 'reserved'
                 check (status in ('reserved', 'paid', 'failed')),
  created_at     timestamptz not null default now(),
  paid_at        timestamptz,
  unique (player_account, reward_day)
);
