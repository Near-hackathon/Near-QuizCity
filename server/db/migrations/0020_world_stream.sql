-- QC-0601: durable per-scene world event stream.

alter table world_events
  add column if not exists event_id text,
  add column if not exists stream_id text,
  add column if not exists sequence bigint,
  add column if not exists protocol_version text,
  add column if not exists entity_type text,
  add column if not exists entity_id text,
  add column if not exists idempotency_key text;

with numbered as (
  select
    id,
    'scene:' || coalesce(scene_id, 'legacy') as stream_id,
    row_number() over (
      partition by 'scene:' || coalesce(scene_id, 'legacy')
      order by id
    ) as sequence
  from world_events
)
update world_events w
set
  event_id = coalesce(w.event_id, 'legacy:' || w.id::text),
  stream_id = coalesce(w.stream_id, n.stream_id),
  sequence = coalesce(w.sequence, n.sequence),
  -- Pre-stream rows remain audit history unless explicitly upgraded below. They
  -- are intentionally excluded from wire replay by the repository.
  protocol_version = coalesce(w.protocol_version, 'legacy'),
  entity_type = coalesce(
    w.entity_type,
    case
      when w.player_account is not null then 'player'
      when w.npc_id is not null then 'npc'
      when w.building_id is not null then 'building'
      when w.scene_id is not null then 'scene'
      else 'scene'
    end
  ),
  entity_id = coalesce(
    w.entity_id,
    w.player_account,
    w.npc_id,
    w.building_id,
    w.scene_id,
    'legacy'
  )
from numbered n
where n.id = w.id;

-- The pre-0020 demo seed is a known durable fact, so upgrade it to the shared
-- wire contract in place. This preserves its audit id and allocated sequence
-- while making a later seed run idempotent on the stable source key.
with initial_kofi_event as (
  select min(id) as id
  from world_events
  where event_type = 'npc_activity'
    and scene_id = 'library-interior'
    and npc_id = 'professor-kofi'
)
update world_events w
set event_id = 'seed:kofi-initial',
    event_type = 'npc.activity_changed',
    protocol_version = '1.0.0',
    entity_type = 'npc',
    entity_id = 'professor-kofi',
    idempotency_key = 'seed:kofi-initial',
    game_time = coalesce(w.game_time, w.observed_at),
    payload = jsonb_build_object(
      'activity', coalesce(w.payload ->> 'activity', 'research'),
      'stateVersion', '0'
    )
from initial_kofi_event seed
where w.id = seed.id;

create table if not exists world_streams (
  stream_id    text primary key,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  updated_at   timestamptz not null default now()
);

insert into world_streams (stream_id, last_sequence)
select stream_id, max(sequence)
from world_events
group by stream_id
on conflict (stream_id) do update set
  last_sequence = greatest(world_streams.last_sequence, excluded.last_sequence),
  updated_at = now();

alter table world_events
  alter column event_id set not null,
  alter column stream_id set not null,
  alter column sequence set not null,
  alter column protocol_version set not null,
  alter column entity_type set not null,
  alter column entity_id set not null;

alter table world_events
  add constraint world_events_stream_id_check
    check (stream_id ~ '^scene:[a-z0-9_-]{1,64}$'),
  add constraint world_events_sequence_check check (sequence > 0),
  add constraint world_events_event_id_check
    check (length(event_id) between 1 and 128),
  add constraint world_events_protocol_version_check
    check (length(protocol_version) between 1 and 32),
  add constraint world_events_event_type_check
    check (length(event_type) between 1 and 64),
  add constraint world_events_entity_type_check
    check (entity_type in ('player', 'npc', 'building', 'door', 'business', 'job', 'property', 'scene')),
  add constraint world_events_entity_id_check
    check (length(entity_id) between 1 and 128),
  add constraint world_events_idempotency_key_check
    check (idempotency_key is null or length(idempotency_key) between 1 and 128),
  add constraint world_events_payload_object_check
    check (jsonb_typeof(payload) = 'object');

create unique index if not exists world_events_event_id_idx on world_events (event_id);
create unique index if not exists world_events_stream_sequence_idx on world_events (stream_id, sequence);
create unique index if not exists world_events_idempotency_idx
  on world_events (idempotency_key) where idempotency_key is not null;
create index if not exists world_events_stream_replay_idx on world_events (stream_id, sequence asc);
create index if not exists world_events_entity_idx on world_events (entity_type, entity_id);
