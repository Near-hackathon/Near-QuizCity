import type { Sql } from "postgres";

/**
 * Minimal connected demo city. Every statement is idempotent so reseeding does
 * not duplicate schedules, spawn links, runtime state, or world events.
 */
export async function seedWorld(sql: Sql): Promise<void> {
  await sql`
    insert into scenes (id, name, scene_type, asset_key, width, height)
    values
      ('city-district', 'Quiz City District', 'exterior', 'maps/city-district', 64, 48),
      ('library-interior', 'City Library', 'interior', 'maps/library', 24, 18),
      ('quiz-centre-interior', 'Quiz Centre', 'interior', 'maps/quiz-centre', 20, 16)
      on conflict (id) do update set
        name = excluded.name,
        scene_type = excluded.scene_type,
        asset_key = excluded.asset_key,
        width = excluded.width,
        height = excluded.height,
        active = true,
        updated_at = now()
  `;

  await sql`
    insert into spawn_points (id, scene_id, kind, x, y, facing)
    values
      ('city-spawn', 'city-district', 'player_default', 32, 24, 'south'),
      ('library-door-exterior', 'city-district', 'door', 20, 10, 'north'),
      ('library-spawn', 'library-interior', 'door', 12, 16, 'north'),
      ('quiz-door-exterior', 'city-district', 'door', 40, 12, 'north'),
      ('quiz-spawn', 'quiz-centre-interior', 'door', 10, 14, 'south')
      on conflict (id) do update set
        scene_id = excluded.scene_id,
        kind = excluded.kind,
        x = excluded.x,
        y = excluded.y,
        facing = excluded.facing,
        active = true
  `;

  await sql`
    insert into buildings (
      id, exterior_scene_id, interior_scene_id, building_type, display_name,
      entrance_x, entrance_y, entrance_facing, operating_hours
    )
    values
      ('building-library', 'city-district', 'library-interior', 'library', 'City Library',
       20, 10, 'north', '{"open":"08:00","close":"20:00"}'::jsonb),
      ('building-quiz-centre', 'city-district', 'quiz-centre-interior', 'quiz_centre',
       'Quiz Centre', 40, 12, 'north', '{"open":"09:00","close":"22:00"}'::jsonb)
      on conflict (id) do update set
        exterior_scene_id = excluded.exterior_scene_id,
        interior_scene_id = excluded.interior_scene_id,
        building_type = excluded.building_type,
        display_name = excluded.display_name,
        entrance_x = excluded.entrance_x,
        entrance_y = excluded.entrance_y,
        entrance_facing = excluded.entrance_facing,
        operating_hours = excluded.operating_hours,
        status = 'active',
        updated_at = now()
  `;

  await sql`
    update spawn_points set
      destination_scene_id = 'library-interior',
      destination_spawn_id = 'library-spawn'
    where id = 'library-door-exterior'
  `;
  await sql`
    update spawn_points set
      destination_scene_id = 'city-district',
      destination_spawn_id = 'library-door-exterior'
    where id = 'library-spawn'
  `;
  await sql`
    update spawn_points set
      destination_scene_id = 'quiz-centre-interior',
      destination_spawn_id = 'quiz-spawn'
    where id = 'quiz-door-exterior'
  `;
  await sql`
    update spawn_points set
      destination_scene_id = 'city-district',
      destination_spawn_id = 'quiz-door-exterior'
    where id = 'quiz-spawn'
  `;

  await sql`
    insert into npc_schedules (
      id, npc_id, sequence, day_mask, start_minute, end_minute, activity,
      destination_scene_id, destination_building_id, destination_spawn_id, parameters
    )
    values
      ('kofi-morning-research', 'professor-kofi', 0, 127, 480, 720, 'research',
       'library-interior', 'building-library', 'library-spawn', '{}'::jsonb),
      ('kofi-afternoon-teach', 'professor-kofi', 1, 127, 720, 1080, 'teach',
       'library-interior', 'building-library', 'library-spawn', '{"course":"city-history"}'::jsonb)
      on conflict (id) do update set
        npc_id = excluded.npc_id,
        sequence = excluded.sequence,
        day_mask = excluded.day_mask,
        start_minute = excluded.start_minute,
        end_minute = excluded.end_minute,
        activity = excluded.activity,
        destination_scene_id = excluded.destination_scene_id,
        destination_building_id = excluded.destination_building_id,
        destination_spawn_id = excluded.destination_spawn_id,
        parameters = excluded.parameters
  `;

  await sql`
    insert into npc_runtime (
      npc_id, scene_id, x, y, activity, target_scene_id, target_spawn_id, state
    )
    values (
      'professor-kofi', 'library-interior', 6, 8, 'research', 'library-interior',
      'library-spawn', '{"mood":"focused"}'::jsonb
    )
    on conflict (npc_id) do nothing
  `;

  await sql`
    insert into world_events (event_type, scene_id, npc_id, x, y, payload, game_time)
    select 'npc_activity', 'library-interior', 'professor-kofi', 6, 8,
           '{"activity":"research"}'::jsonb, now()
    where not exists (
      select 1 from world_events
      where event_type = 'npc_activity' and npc_id = 'professor-kofi'
    )
  `;
}
