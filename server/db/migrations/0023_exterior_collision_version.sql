-- Phase 7 exterior geometry, applied while application instances are stopped.
-- Preserve identities/command receipts; clear old paths and relocate only new obstacles.
update scenes set asset_version = 2, updated_at = now() where id = 'city-district';

update player_presence set
  x = case when
    (x between 17 and 23 and y between 6 and 9) or
    (x between 37 and 43 and y between 8 and 11) or
    (x between 47 and 53 and y between 6 and 9) or
    (x between 7 and 13 and y between 32 and 35) or
    (x between 42 and 48 and y between 31 and 34)
    then 32 else x end,
  y = case when
    (x between 17 and 23 and y between 6 and 9) or
    (x between 37 and 43 and y between 8 and 11) or
    (x between 47 and 53 and y between 6 and 9) or
    (x between 7 and 13 and y between 32 and 35) or
    (x between 42 and 48 and y between 31 and 34)
    then 24 else y end,
  path = '[]'::jsonb, path_index = 0, scene_version = 2, state_version = state_version + 1
where scene_id = 'city-district';
