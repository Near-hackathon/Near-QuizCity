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
      ('quiz-centre-interior', 'Quiz Centre', 'interior', 'maps/quiz-centre', 20, 16),
      ('apartment-interior', 'Professor Kofi Apartment', 'interior', 'maps/apartment', 14, 12),
      ('university-interior', 'Quiz City University', 'interior', 'maps/university', 28, 20),
      ('cafe-interior', 'Knowledge Cafe', 'interior', 'maps/cafe', 16, 12)
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
      ('library-default', 'library-interior', 'player_default', 12, 12, 'south'),
      ('quiz-door-exterior', 'city-district', 'door', 40, 12, 'north'),
      ('quiz-spawn', 'quiz-centre-interior', 'door', 10, 14, 'south'),
      ('quiz-default', 'quiz-centre-interior', 'player_default', 10, 11, 'south'),
      ('library-desk', 'library-interior', 'npc_waypoint', 6, 8, 'south'),
      ('apartment-door-exterior', 'city-district', 'door', 10, 36, 'north'),
      ('apartment-spawn', 'apartment-interior', 'door', 7, 10, 'north'),
      ('apartment-default', 'apartment-interior', 'player_default', 7, 7, 'south'),
      ('apartment-home', 'apartment-interior', 'npc_waypoint', 6, 5, 'south'),
      ('university-door-exterior', 'city-district', 'door', 50, 10, 'north'),
      ('university-spawn', 'university-interior', 'door', 14, 18, 'north'),
      ('university-default', 'university-interior', 'player_default', 14, 15, 'south'),
      ('research-desk', 'university-interior', 'npc_waypoint', 14, 8, 'north'),
      ('cafe-door-exterior', 'city-district', 'door', 45, 35, 'north'),
      ('cafe-spawn', 'cafe-interior', 'door', 8, 10, 'north'),
      ('cafe-default', 'cafe-interior', 'player_default', 8, 7, 'south'),
      ('cafe-table', 'cafe-interior', 'npc_waypoint', 8, 5, 'south'),
      ('park-waypoint', 'city-district', 'npc_waypoint', 30, 35, 'south')
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
       'Quiz Centre', 40, 12, 'north', '{"open":"09:00","close":"22:00"}'::jsonb),
      ('building-apartment', 'city-district', 'apartment-interior', 'apartment',
       'Professor Kofi Apartment', 10, 36, 'north', '{}'::jsonb),
      ('building-university', 'city-district', 'university-interior', 'university',
       'Quiz City University', 50, 10, 'north', '{"open":"07:00","close":"21:00"}'::jsonb),
      ('building-cafe', 'city-district', 'cafe-interior', 'restaurant',
       'Knowledge Cafe', 45, 35, 'north', '{"open":"06:00","close":"23:00"}'::jsonb)
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
  for (const link of [
    ["apartment-door-exterior", "apartment-interior", "apartment-spawn"],
    ["apartment-spawn", "city-district", "apartment-door-exterior"],
    ["university-door-exterior", "university-interior", "university-spawn"],
    ["university-spawn", "city-district", "university-door-exterior"],
    ["cafe-door-exterior", "cafe-interior", "cafe-spawn"],
    ["cafe-spawn", "city-district", "cafe-door-exterior"],
  ] as const) {
    await sql`
      update spawn_points set destination_scene_id = ${link[1]}, destination_spawn_id = ${link[2]}
      where id = ${link[0]}
    `;
  }

  // The routine is replaced as one unit so an old schedule with the same
  // (npc_id, sequence) cannot leave a partially upgraded day behind.
  await sql`delete from npc_schedules where npc_id = 'professor-kofi'`;

  await sql`
    insert into npc_schedules (
      id, npc_id, sequence, day_mask, start_minute, end_minute, activity,
      destination_scene_id, destination_building_id, destination_spawn_id, parameters
    )
    values
      ('kofi-home-morning', 'professor-kofi', 0, 127, 0, 480, 'home',
       'apartment-interior', 'building-apartment', 'apartment-home', '{}'::jsonb),
      ('kofi-university-research', 'professor-kofi', 1, 127, 480, 720, 'research',
       'university-interior', 'building-university', 'research-desk', '{}'::jsonb),
      ('kofi-library-research', 'professor-kofi', 2, 127, 720, 900, 'library_research',
       'library-interior', 'building-library', 'library-desk', '{}'::jsonb),
      ('kofi-park-break', 'professor-kofi', 3, 127, 900, 1020, 'park_break',
       'city-district', null, 'park-waypoint', '{}'::jsonb),
      ('kofi-cafe', 'professor-kofi', 4, 127, 1020, 1140, 'cafe',
       'cafe-interior', 'building-cafe', 'cafe-table', '{}'::jsonb),
      ('kofi-home-evening', 'professor-kofi', 5, 127, 1140, 1440, 'home',
       'apartment-interior', 'building-apartment', 'apartment-home', '{}'::jsonb)
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

  await sql.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(hashtextextended('world-event:seed:kofi-initial', 0))
    `;
    const [existing] = await transaction<{ id: string }[]>`
      select id::text as id from world_events
      where idempotency_key = 'seed:kofi-initial'
    `;
    if (existing) return;

    const [stream] = await transaction<{ sequence: string }[]>`
      insert into world_streams (stream_id, last_sequence)
      values ('scene:library-interior', 1)
      on conflict (stream_id) do update set
        last_sequence = world_streams.last_sequence + 1,
        updated_at = now()
      returning last_sequence::text as sequence
    `;
    await transaction`
      insert into world_events (
        event_type, scene_id, npc_id, x, y, payload, game_time,
        event_id, stream_id, sequence, protocol_version, entity_type, entity_id, idempotency_key
      ) values (
        'npc.activity_changed', 'library-interior', 'professor-kofi', 6, 8,
        '{"activity":"research","stateVersion":"0"}'::jsonb, now(),
        'seed:kofi-initial', 'scene:library-interior', ${stream.sequence}::bigint,
        '1.0.0', 'npc', 'professor-kofi', 'seed:kofi-initial'
      )
    `;
  });
}
