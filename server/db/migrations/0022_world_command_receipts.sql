-- QC-0604: restart-safe command idempotency and independent token buckets.

alter table player_presence
  add column if not exists movement_tokens double precision,
  add column if not exists interaction_tokens double precision;

alter table player_presence
  add constraint player_presence_movement_tokens_check
    check (movement_tokens is null or movement_tokens >= 0),
  add constraint player_presence_interaction_tokens_check
    check (interaction_tokens is null or interaction_tokens >= 0);

create table if not exists world_command_receipts (
  session_id       text not null references player_presence (session_id) on delete cascade,
  message_id       text not null,
  client_sequence  bigint not null,
  command_type     text not null,
  fingerprint      text not null,
  result           jsonb not null,
  created_at       timestamptz not null default now(),
  primary key (session_id, message_id),
  unique (session_id, client_sequence),
  check (length(message_id) between 1 and 128),
  check (client_sequence >= 0),
  check (command_type in ('world.move_intent', 'world.interact')),
  check (length(fingerprint) between 1 and 512),
  check (jsonb_typeof(result) = 'object')
);

create index if not exists world_command_receipts_created_idx
  on world_command_receipts (created_at);
