-- QC-0304: durable job payment attempts and unknown-outcome reconciliation.

alter table jobs drop constraint if exists jobs_status_check;

alter table jobs
  add column if not exists payment_next_check_at timestamptz,
  add column if not exists payment_first_checked_at timestamptz,
  add column if not exists payment_error_code text,
  add column if not exists payment_reconciliation_reason text;

update jobs set
  payment_next_check_at = coalesce(payment_next_check_at, payment_started_at),
  payment_first_checked_at = coalesce(payment_first_checked_at, payment_started_at)
where payment_attempts > 0;

alter table jobs
  add constraint jobs_status_check check (
    status in (
      'open', 'accepted', 'submitted', 'verified', 'payment_pending',
      'payment_unknown', 'payment_failed', 'paid', 'cancelled'
    )
  );

create index if not exists jobs_payment_reconcile_idx
  on jobs (payment_next_check_at) where status in ('payment_pending', 'payment_unknown', 'payment_failed');

create table if not exists job_payment_attempts (
  id               bigserial primary key,
  job_id           text not null references jobs (id) on delete cascade,
  attempt          integer not null,
  reference        text not null,
  state            text not null check (state in ('pending', 'unknown', 'confirmed', 'rejected', 'failed')),
  tx_hash          text,
  error_code       text,
  error_message    text,
  check_count      integer not null default 0,
  next_check_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (job_id, attempt),
  check (attempt > 0),
  check (reference <> '')
);
