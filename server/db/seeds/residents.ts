import type { Sql } from "postgres";
import { residentRoutines, residentSpawns } from "@quiz-city/world-data";

/** Add the starter residents without resetting their positions, versions or the venue hours. */
export async function seedResidents(sql: Sql) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':quizcity-npc-simulation',0))`;
    for (const [sceneId, spawns] of Object.entries(residentSpawns))
      for (const spawn of spawns)
        await tx`insert into spawn_points (id,scene_id,kind,x,y,facing)
          values (${spawn.id},${sceneId},${spawn.kind},${spawn.x},${spawn.y},'south')
          on conflict (id) do update set scene_id=excluded.scene_id,x=excluded.x,y=excluded.y,active=true`;
    for (const [npcId, routine] of Object.entries(residentRoutines)) {
      await tx`delete from npc_schedules where npc_id=${npcId}`;
      for (const [sequence, stop] of routine.entries()) {
        const buildingId =
          stop.scene === "city-district" ? null : `building-${stop.scene.replace(/-interior$/, "")}`;
        await tx`insert into npc_schedules (id,npc_id,sequence,day_mask,start_minute,end_minute,activity,destination_scene_id,destination_building_id,destination_spawn_id,parameters)
          values (${stop.id},${npcId},${sequence},127,${stop.start},${stop.end},${stop.activity},${stop.scene},${buildingId},${stop.spawn},${tx.json(stop.patrol ? { patrol: stop.patrol } : {})})
          on conflict (id) do update set sequence=excluded.sequence,start_minute=excluded.start_minute,end_minute=excluded.end_minute,
            activity=excluded.activity,destination_scene_id=excluded.destination_scene_id,destination_building_id=excluded.destination_building_id,destination_spawn_id=excluded.destination_spawn_id`;
      }
      const home = routine[0];
      const spawn = residentSpawns[home.scene].find((point) => point.id === home.spawn)!;
      await tx`insert into npc_runtime (npc_id,scene_id,x,y,activity,state)
        values (${npcId},${home.scene},${spawn.x},${spawn.y},${home.activity},'{}'::jsonb)
        on conflict (npc_id) do nothing`;
    }
  });
}
