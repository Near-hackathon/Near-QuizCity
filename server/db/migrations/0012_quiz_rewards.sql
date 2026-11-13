-- QC-0305: quiz configuration, funded reward accounting, and reward reconciliation.

alter table quizzes
  add column if not exists question_count integer,
  add column if not exists pass_score integer,
  add column if not exists reward_amount numeric(39,0),
  add column if not exists attempt_duration_seconds integer,
  add column if not exists daily_limit integer not null default 1,
  add column if not exists funding_model text not null default 'mint',
  add column if not exists reward_reserved numeric(39,0) not null default 0,
  add column if not exists reward_paid numeric(39,0) not null default 0;

update quizzes q set
  question_count = coalesce(
    nullif((select count(*) from quiz_questions qq where qq.quiz_id = q.id), 0),
    question_count,
    1
  ),
  pass_score = coalesce(pass_score, 6),
  reward_amount = coalesce(reward_amount, 25),
  attempt_duration_seconds = coalesce(attempt_duration_seconds, 600)
where question_count is null or pass_score is null or reward_amount is null
   or attempt_duration_seconds is null;

alter table quizzes
  alter column question_count set default 1,
  alter column question_count set not null,
  alter column pass_score set default 0,
  alter column pass_score set not null,
  alter column reward_amount set default 0,
  alter column reward_amount set not null,
  alter column attempt_duration_seconds set default 600,
  alter column attempt_duration_seconds set not null;

alter table quizzes
  add constraint quizzes_question_count_check check (question_count > 0),
  add constraint quizzes_pass_score_check check (pass_score >= 0 and pass_score <= question_count),
  add constraint quizzes_reward_amount_check check (reward_amount >= 0),
  add constraint quizzes_duration_check check (attempt_duration_seconds > 0),
  add constraint quizzes_daily_limit_check check (daily_limit >= 1),
  add constraint quizzes_funding_model_check check (funding_model in ('mint', 'funded')),
  add constraint quizzes_pool_check check (
    reward_pool >= 0 and reward_reserved >= 0 and reward_paid >= 0
    and reward_reserved + reward_paid <= reward_pool
  );

alter table quiz_attempts
  add column if not exists reward_state text not null default 'none'
    check (reward_state in ('none', 'pending', 'unknown', 'paid', 'failed')),
  add column if not exists reward_error_code text,
  add column if not exists reward_first_checked_at timestamptz,
  add column if not exists reward_next_check_at timestamptz,
  add column if not exists reward_check_count integer not null default 0;

create index if not exists quiz_attempts_reward_reconcile_idx
  on quiz_attempts (reward_next_check_at)
  where reward_state in ('pending', 'unknown', 'failed');
