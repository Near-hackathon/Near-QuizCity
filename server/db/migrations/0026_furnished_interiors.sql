-- New room layouts; apply with application instances stopped. Economic data is untouched.
create temporary table quizcity_interior_furniture (
  scene_id text, x integer, y integer, width integer, height integer
) on commit drop;
insert into quizcity_interior_furniture values
  ('library-interior', 6, 10, 2, 1),
  ('library-interior', 6, 11, 1, 1),
  ('library-interior', 10, 10, 2, 1),
  ('library-interior', 10, 11, 1, 1),
  ('library-interior', 17, 9, 2, 1),
  ('library-interior', 17, 10, 1, 1),
  ('library-interior', 2, 6, 1, 1),
  ('library-interior', 2, 9, 1, 1),
  ('library-interior', 20, 14, 1, 1),
  ('university-interior', 6, 7, 2, 1),
  ('university-interior', 6, 8, 1, 1),
  ('university-interior', 11, 7, 2, 1),
  ('university-interior', 11, 8, 1, 1),
  ('university-interior', 17, 7, 2, 1),
  ('university-interior', 17, 8, 1, 1),
  ('university-interior', 6, 11, 2, 1),
  ('university-interior', 6, 12, 1, 1),
  ('university-interior', 11, 11, 2, 1),
  ('university-interior', 11, 12, 1, 1),
  ('university-interior', 17, 11, 2, 1),
  ('university-interior', 17, 12, 1, 1),
  ('university-interior', 14, 4, 2, 1),
  ('university-interior', 24, 5, 1, 1),
  ('university-interior', 3, 6, 1, 1),
  ('apartment-interior', 3, 6, 2, 2),
  ('apartment-interior', 9, 4, 2, 1),
  ('apartment-interior', 9, 5, 1, 1),
  ('apartment-interior', 8, 2, 2, 1),
  ('apartment-interior', 11, 2, 1, 1),
  ('apartment-interior', 2, 8, 1, 1),
  ('cafe-interior', 3, 5, 4, 1),
  ('cafe-interior', 3, 3, 1, 1),
  ('cafe-interior', 10, 4, 2, 1),
  ('cafe-interior', 10, 5, 1, 1),
  ('cafe-interior', 10, 7, 2, 1),
  ('cafe-interior', 10, 8, 1, 1),
  ('cafe-interior', 4, 8, 2, 1),
  ('cafe-interior', 4, 9, 1, 1),
  ('cafe-interior', 13, 9, 1, 1),
  ('quiz-centre-interior', 3, 5, 2, 1),
  ('quiz-centre-interior', 3, 6, 1, 1),
  ('quiz-centre-interior', 15, 5, 2, 1),
  ('quiz-centre-interior', 15, 6, 1, 1),
  ('quiz-centre-interior', 3, 10, 2, 1),
  ('quiz-centre-interior', 3, 11, 1, 1),
  ('quiz-centre-interior', 15, 10, 2, 1),
  ('quiz-centre-interior', 15, 11, 1, 1),
  ('quiz-centre-interior', 17, 3, 1, 1),
  ('quiz-centre-interior', 2, 12, 1, 1);

update scenes set asset_version = 3, updated_at = now()
where id in (select distinct scene_id from quizcity_interior_furniture);

update player_presence p set
  x = case when exists (select 1 from quizcity_interior_furniture f where f.scene_id = p.scene_id and p.x >= f.x and p.x < f.x+f.width and p.y >= f.y and p.y < f.y+f.height) then sp.x else p.x end,
  y = case when exists (select 1 from quizcity_interior_furniture f where f.scene_id = p.scene_id and p.x >= f.x and p.x < f.x+f.width and p.y >= f.y and p.y < f.y+f.height) then sp.y else p.y end,
  path = '[]'::jsonb, path_index = 0, scene_version = 3, state_version = p.state_version + 1
from spawn_points sp where sp.scene_id = p.scene_id and sp.kind = 'player_default'
  and p.scene_id in (select distinct scene_id from quizcity_interior_furniture);

update npc_runtime n set
  x = case when exists (select 1 from quizcity_interior_furniture f where f.scene_id = n.scene_id and n.x >= f.x and n.x < f.x+f.width and n.y >= f.y and n.y < f.y+f.height) then sp.x else n.x end,
  y = case when exists (select 1 from quizcity_interior_furniture f where f.scene_id = n.scene_id and n.x >= f.x and n.x < f.x+f.width and n.y >= f.y and n.y < f.y+f.height) then sp.y else n.y end,
  target_x = null, target_y = null, target_scene_id = null, target_spawn_id = null, state_version = n.state_version + 1
from spawn_points sp where sp.scene_id = n.scene_id and sp.kind = 'player_default'
  and n.scene_id in (select distinct scene_id from quizcity_interior_furniture);
