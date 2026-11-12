-- QC-0204: race-safe job payment state and deterministic chain references.

alter table jobs drop constraint if exists jobs_status_check;

alter table jobs
  add column if not exists deliverable text,
  add column if not exists verification_notes text,
  add column if not exists payment_reference text,
  add column if not exists payment_attempts integer not null default 0,
  add column if not exists last_error text,
  add column if not exists accepted_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists payment_started_at timestamptz,
  add column if not exists paid_at timestamptz,
  add column if not exists cancelled_at timestamptz;

-- Disposable demo rows: completed legacy jobs become submitted, not verified,
-- so no historical row is silently treated as having passed verification.
update jobs set
  status = case
    when status = 'completed' then 'submitted'
    when status = 'accepted' then 'accepted'
    when status = 'paid' then 'paid'
    when status = 'cancelled' then 'cancelled'
    else 'open'
  end,
  accepted_at = coalesce(accepted_at, case when employee_account is not null then created_at else null end),
  submitted_at = coalesce(submitted_at, case when status = 'completed' then created_at else null end),
  payment_reference = coalesce(payment_reference, case when status = 'paid' then 'job:' || id else null end),
  paid_at = coalesce(paid_at, case when status = 'paid' then created_at else null end);

alter table jobs
  add constraint jobs_status_check check (
    status in (
      'open', 'accepted', 'submitted', 'verified', 'payment_pending',
      'paid', 'payment_failed', 'cancelled'
    )
  );

create unique index if not exists jobs_payment_reference_idx on jobs (payment_reference);
create index if not exists jobs_status_idx_new on jobs (status);
