-- Apply with application instances stopped. Preserve sessions and receipts.
create temporary table quizcity_prop_footprints (
  scene_id text, x integer, y integer, width integer, height integer
) on commit drop;
insert into quizcity_prop_footprints
  select 'city-district', x, y, 1, 1
  from generate_series(4, 59, 5) x cross join (values (29), (43)) ys(y);
insert into quizcity_prop_footprints values
  ('city-district', 25, 32, 1, 1), ('city-district', 34, 37, 1, 1),
  ('city-district', 37, 33, 1, 1), ('city-district', 24, 39, 1, 1),
  ('city-district', 29, 35, 1, 1);
insert into quizcity_prop_footprints
  select id, 4, 3, case when id = 'apartment-interior' then 2 else 1 end, 1
  from scenes where id in ('library-interior','quiz-centre-interior','apartment-interior','university-interior','cafe-interior');
insert into quizcity_prop_footprints
  select id, width - 4, 3, 1, 1 from scenes
  where id in ('library-interior','quiz-centre-interior','apartment-interior','university-interior','cafe-interior');

update scenes set asset_version = case when id = 'city-district' then 3 else 2 end,
  updated_at = now() where id in ('city-district','library-interior','quiz-centre-interior','apartment-interior','university-interior','cafe-interior');

update player_presence p set
  x = case when exists (select 1 from quizcity_prop_footprints b where b.scene_id = p.scene_id and p.x >= b.x and p.x < b.x+b.width and p.y >= b.y and p.y < b.y+b.height) then sp.x else p.x end,
  y = case when exists (select 1 from quizcity_prop_footprints b where b.scene_id = p.scene_id and p.x >= b.x and p.x < b.x+b.width and p.y >= b.y and p.y < b.y+b.height) then sp.y else p.y end,
  path = '[]'::jsonb, path_index = 0, scene_version = s.asset_version::bigint,
  state_version = p.state_version + 1
from scenes s, spawn_points sp where p.scene_id = s.id and sp.scene_id = s.id and sp.kind = 'player_default'
  and s.id in ('city-district','library-interior','quiz-centre-interior','apartment-interior','university-interior','cafe-interior');

update npc_runtime n set x = sp.x, y = sp.y, target_x = null, target_y = null,
  target_scene_id = null, target_spawn_id = null, state_version = n.state_version + 1
from spawn_points sp where sp.scene_id = n.scene_id and sp.kind = 'player_default'
  and exists (select 1 from quizcity_prop_footprints b where b.scene_id = n.scene_id and n.x >= b.x and n.x < b.x+b.width and n.y >= b.y and n.y < b.y+b.height);
