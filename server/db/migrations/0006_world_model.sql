-- QC-0205: visible world, buildings, NPC schedules/runtime, and presence.

create table if not exists scenes (
  id            text primary key,
  name          text not null,
  scene_type    text not null check (scene_type in ('exterior', 'interior')),
  asset_key     text not null,
  asset_version text not null default '1',
  width         integer not null check (width > 0),
  height        integer not null check (height > 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists buildings (
  id             text primary key,
  exterior_scene_id text not null references scenes (id),
  interior_scene_id text references scenes (id),
  property_id    bigint references properties (id),
  business_id    bigint references businesses (id),
  building_type  text not null,
  display_name   text not null,
  entrance_x     integer not null,
  entrance_y     integer not null,
  entrance_facing text not null default 'south',
  operating_hours jsonb not null default '{}'::jsonb,
  status         text not null default 'active' check (status in ('active', 'closed', 'hidden')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists buildings_exterior_scene_idx on buildings (exterior_scene_id);
create index if not exists buildings_interior_scene_idx on buildings (interior_scene_id);
create index if not exists buildings_property_idx on buildings (property_id);
create index if not exists buildings_business_idx on buildings (business_id);
create index if not exists buildings_type_idx on buildings (building_type);

create table if not exists spawn_points (
  id                  text primary key,
  scene_id            text not null references scenes (id) on delete cascade,
  kind                text not null,
  x                   integer not null,
  y                   integer not null,
  layer               integer not null default 0,
  facing              text not null default 'south',
  destination_scene_id text references scenes (id),
  destination_spawn_id text references spawn_points (id),
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create index if not exists spawn_points_scene_idx on spawn_points (scene_id);
create index if not exists spawn_points_kind_idx on spawn_points (kind);

create table if not exists npc_schedules (
  id                    text primary key,
  npc_id                text not null,
  sequence              integer not null check (sequence >= 0),
  day_mask              integer not null default 127 check (day_mask between 0 and 127),
  start_minute          integer not null check (start_minute between 0 and 1439),
  end_minute            integer not null check (end_minute between 1 and 1440),
  activity              text not null,
  destination_scene_id  text references scenes (id),
  destination_building_id text references buildings (id),
  destination_spawn_id  text references spawn_points (id),
  parameters            jsonb not null default '{}'::jsonb,
  unique (npc_id, sequence),
  check (end_minute > start_minute)
);
create index if not exists npc_schedules_npc_idx on npc_schedules (npc_id, sequence);

create table if not exists npc_runtime (
  npc_id             text primary key,
  scene_id           text not null references scenes (id),
  x                  integer not null,
  y                  integer not null,
  activity           text not null,
  target_scene_id    text references scenes (id),
  target_spawn_id    text references spawn_points (id),
  target_x           integer,
  target_y           integer,
  state              jsonb not null default '{}'::jsonb,
  state_version      bigint not null default 0,
  last_simulated_at  timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists npc_runtime_scene_idx on npc_runtime (scene_id);

create table if not exists world_events (
  id             bigserial primary key,
  event_type     text not null,
  scene_id       text references scenes (id),
  building_id    text references buildings (id),
  npc_id         text,
  player_account text,
  x              integer,
  y              integer,
  payload        jsonb not null default '{}'::jsonb,
  game_time      timestamptz,
  observed_at    timestamptz not null default now(),
  chain_reference text
);
create index if not exists world_events_scene_time_idx on world_events (scene_id, observed_at desc);
create index if not exists world_events_npc_time_idx on world_events (npc_id, observed_at desc);
create index if not exists world_events_player_time_idx on world_events (player_account, observed_at desc);
create index if not exists world_events_building_time_idx on world_events (building_id, observed_at desc);
create index if not exists world_events_chain_ref_idx on world_events (chain_reference);

create table if not exists player_presence (
  session_id     text primary key,
  player_account text not null,
  scene_id       text not null references scenes (id),
  x              integer not null,
  y              integer not null,
  facing         text not null default 'south',
  state_version  bigint not null default 0,
  heartbeat_at   timestamptz not null default now()
);
create index if not exists player_presence_player_idx on player_presence (player_account);
create index if not exists player_presence_heartbeat_idx on player_presence (heartbeat_at);
