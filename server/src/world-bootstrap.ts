import type { Sql } from "postgres";
import type { WorldBootstrapType } from "@quiz-city/protocol";
import { PROTOCOL_VERSION } from "@quiz-city/protocol";
import { AppError } from "./errors.js";
import { streamHead } from "./world-events.js";

const MAX_ROWS = 500;
const SCENE_PATTERN = /^[a-z0-9_-]{1,64}$/;
const MAX_BOOTSTRAP_PLAYERS = 200;

type SceneRow = {
  id: string;
  name: string;
  scene_type: "exterior" | "interior";
  width: number;
  height: number;
  asset_key: string;
  asset_version: string;
};

export async function buildWorldBootstrap(
  db: Sql,
  accountId: string,
  sceneId: string,
  options: {
    now?: () => Date;
    cityTime?: (serverTime: Date) => Date;
    afterSnapshotEstablished?: () => Promise<void>;
    /** When supplied, restore only the authenticated session's position. */
    sessionId?: string;
  } = {},
): Promise<WorldBootstrapType> {
  if (!SCENE_PATTERN.test(sceneId)) {
    throw new AppError("VALIDATION_ERROR", "invalid scene id", 400);
  }
  const capturedNow = (options.now ?? (() => new Date()))();
  const capturedCityTime = (options.cityTime ?? ((value: Date) => value))(capturedNow);
  return db.begin("isolation level repeatable read read only", async (transaction) => {
    const [scene] = await transaction<SceneRow[]>`
      select id, name, scene_type, width, height, asset_key, asset_version
      from scenes where id = ${sceneId} and active = true
    `;
    if (!scene) throw new AppError("NOT_FOUND", "scene not found", 404);
    await options.afterSnapshotEstablished?.();

    const [presence] = await transaction<
      { x: number; y: number; facing: string; state_version: string; last_client_sequence: string }[]
    >`
      select x, y, facing, state_version::text as state_version,
             last_client_sequence::text as last_client_sequence
      from player_presence
      where player_account = ${accountId} and scene_id = ${sceneId}
        and (${options.sessionId ?? null}::text is null or session_id = ${options.sessionId ?? null})
      order by heartbeat_at desc limit 1
    `;
    const [spawn] = await transaction<{ x: number; y: number; facing: string }[]>`
      select x, y, facing from spawn_points
      where scene_id = ${sceneId} and kind = 'player_default' and active = true
      order by id limit 1
    `;
    if (!presence && !spawn) {
      throw new AppError("CONFLICT", "scene has no spawn point for this player", 409);
    }
    const me = {
      accountId,
      x: presence?.x ?? spawn.x,
      y: presence?.y ?? spawn.y,
      facing: (presence?.facing ?? spawn.facing) as WorldBootstrapType["player"]["facing"],
      stateVersion: presence?.state_version ?? "0",
      lastClientSequence: presence?.last_client_sequence ?? "0",
    };

    const buildings = await transaction<
      {
        id: string;
        display_name: string;
        building_type: string;
        entrance_x: number;
        entrance_y: number;
        entrance_facing: string;
        status: "active" | "closed";
      }[]
    >`
      select id, display_name, building_type, entrance_x, entrance_y, entrance_facing, status
      from buildings
      where exterior_scene_id = ${sceneId} and status <> 'hidden'
      order by id limit ${MAX_ROWS}
    `;
    const spawns = await transaction<
      {
        id: string;
        kind: string;
        x: number;
        y: number;
        facing: string;
        destination_scene_id: string | null;
        destination_spawn_id: string | null;
      }[]
    >`
      select id, kind, x, y, facing, destination_scene_id, destination_spawn_id
      from spawn_points where scene_id = ${sceneId} and active = true
      order by id limit ${MAX_ROWS}
    `;
    const npcs = await transaction<
      {
        npc_id: string;
        scene_id: string;
        x: number;
        y: number;
        activity: string;
        target_x: number | null;
        target_y: number | null;
        state_version: string;
      }[]
    >`
      select npc_id, scene_id, x, y, activity, target_x, target_y,
             state_version::text as state_version
      from npc_runtime where scene_id = ${sceneId}
      order by npc_id limit 200
    `;
    const players = await transaction<
      { player_account: string; x: number; y: number; facing: string; state_version: string }[]
    >`
      select player_account, x, y, facing, state_version
      from (
        select distinct on (player_account)
               player_account, x, y, facing, state_version::text as state_version, heartbeat_at
        from player_presence
        where scene_id = ${sceneId} and player_account <> ${accountId}
        order by player_account, heartbeat_at desc
      ) latest
      order by player_account limit ${MAX_BOOTSTRAP_PLAYERS}
    `;
    const properties = await transaction<{ id: string; for_sale: boolean; price: string }[]>`
      select distinct p.id, p.for_sale, p.price::text as price
      from properties p
      join buildings b on b.property_id = p.id
      where p.active = true and b.status <> 'hidden'
        and (b.exterior_scene_id = ${sceneId} or b.interior_scene_id = ${sceneId})
      order by p.id limit ${MAX_ROWS}
    `;
    const businesses = await transaction<
      { id: string; name: string; status: "open" | "closed" | "suspended" }[]
    >`
      select distinct business.id, business.name, business.status
      from businesses business
      join buildings b on b.business_id = business.id
      where business.active = true and b.status <> 'hidden'
        and (b.exterior_scene_id = ${sceneId} or b.interior_scene_id = ${sceneId})
      order by business.id limit ${MAX_ROWS}
    `;
    const head = await streamHead(transaction, `scene:${sceneId}`);

    return {
      type: "world.bootstrap",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: capturedNow.toISOString(),
      cityTime: capturedCityTime.toISOString(),
      streamId: `scene:${sceneId}`,
      lastSequence: head,
      scene: {
        id: scene.id,
        name: scene.name,
        sceneType: scene.scene_type,
        width: scene.width,
        height: scene.height,
        assetKey: scene.asset_key,
        assetVersion: scene.asset_version,
      },
      player: me,
      buildings: buildings.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        buildingType: row.building_type,
        entranceX: row.entrance_x,
        entranceY: row.entrance_y,
        entranceFacing: row.entrance_facing as WorldBootstrapType["player"]["facing"],
        status: row.status,
      })),
      interactionZones: [
        ...buildings.map((row) => ({
          id: row.id,
          kind: row.building_type,
          x: row.entrance_x,
          y: row.entrance_y,
          radius: 2,
        })),
        ...spawns
          .filter((row) => row.kind === "door")
          .map((row) => ({ id: row.id, kind: "door", x: row.x, y: row.y, radius: 1 })),
      ].slice(0, MAX_ROWS),
      spawns: spawns.map((row) => ({
        id: row.id,
        kind: row.kind,
        x: row.x,
        y: row.y,
        facing: row.facing as WorldBootstrapType["player"]["facing"],
        destinationSceneId: row.destination_scene_id,
        destinationSpawnId: row.destination_spawn_id,
      })),
      npcs: npcs.map((row) => ({
        npcId: row.npc_id,
        sceneId: row.scene_id,
        x: row.x,
        y: row.y,
        activity: row.activity,
        targetX: row.target_x,
        targetY: row.target_y,
        stateVersion: row.state_version,
      })),
      players: players.map((row) => ({
        accountId: row.player_account,
        x: row.x,
        y: row.y,
        facing: row.facing as WorldBootstrapType["player"]["facing"],
        stateVersion: row.state_version,
      })),
      properties: properties.map((row) => ({
        id: row.id,
        forSale: row.for_sale,
        price: row.price,
      })),
      businesses: businesses.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
      })),
    };
  });
}
