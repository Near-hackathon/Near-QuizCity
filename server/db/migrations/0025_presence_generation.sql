-- Presence rows are ephemeral; world events persist after those rows expire.
-- Give each incarnation a new identity so reset state counters cannot collide
-- with immutable checkpoint events from a previous visit using the same session.
alter table player_presence
  add column presence_generation uuid not null default gen_random_uuid(),
  add constraint player_presence_generation_unique unique (presence_generation);
