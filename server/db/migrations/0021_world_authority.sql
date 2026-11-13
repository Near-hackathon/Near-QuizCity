-- QC-0604: persisted authoritative presence commands, paths, and cooldowns.

alter table player_presence
  add column if not exists last_client_sequence bigint not null default 0,
  add column if not exists last_message_id text,
  add column if not exists path jsonb not null default '[]'::jsonb,
  add column if not exists path_index integer not null default 0,
  add column if not exists movement_cooldown_at timestamptz,
  add column if not exists interaction_cooldown_at timestamptz,
  add column if not exists scene_version bigint not null default 0;

alter table player_presence
  add constraint player_presence_sequence_check check (last_client_sequence >= 0),
  add constraint player_presence_message_check check (
    last_message_id is null or length(last_message_id) between 1 and 128
  ),
  add constraint player_presence_path_check check (jsonb_typeof(path) = 'array'),
  add constraint player_presence_path_index_check check (path_index >= 0),
  add constraint player_presence_version_check check (state_version >= 0 and scene_version >= 0);

create index if not exists player_presence_stale_idx on player_presence (scene_id, heartbeat_at);
