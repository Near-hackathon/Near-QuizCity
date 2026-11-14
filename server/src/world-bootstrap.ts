import type { Sql } from "postgres";
import type { WorldBootstrapType } from "@quiz-city/protocol";
import { PROTOCOL_VERSION } from "@quiz-city/protocol";
import { AppError } from "./errors.js";
import { streamHead } from "./world-events.js";
import { worldScenes, isVenueOpen } from "@quiz-city/world-data";

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
    movement?: { stepMs: number; tilesPerTick: number };
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
        property_id: string | null;
        business_id: string | null;
        operating_hours: { open?: string; close?: string } | null;
        status: "active" | "closed";
      }[]
    >`
      select id, display_name, building_type, entrance_x, entrance_y, entrance_facing, status, operating_hours,
             property_id::text as property_id, business_id::text as business_id
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
        has_job: boolean;
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
             state_version::text as state_version,
             exists(select 1 from jobs j where j.employer_wallet='npc:'||npc_runtime.npc_id and j.status='open') as has_job
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
    const profiles = await transaction<
      { account_id: string; username: string }[]
    >`select account_id,username from resident_profiles where account_id=any(${transaction.array([accountId, ...players.map((p) => p.player_account)])}::text[])`;
    const names = new Map(profiles.map((p) => [p.account_id, p.username]));
    const properties = await transaction<
      {
        id: string;
        for_sale: boolean;
        price: string;
        x: number;
        y: number;
        condition: number;
        utilities_active: boolean;
      }[]
    >`
      select distinct p.id, p.for_sale, p.price::text as price, p.x, p.y,coalesce(c.condition,100) as condition,coalesce(c.utilities_paid_until>${capturedNow},true) as utilities_active
      from properties p left join property_condition c on c.property_id=p.id
      left join buildings b on b.property_id = p.id
      where p.active = true and (
        (b.status <> 'hidden' and (b.exterior_scene_id = ${sceneId} or b.interior_scene_id = ${sceneId}))
        or (${sceneId} = 'city-district' and p.district = 'knowledge' and b.id is null)
      )
      order by p.id limit ${MAX_ROWS}
    `;
    const businesses = await transaction<
      {
        id: string;
        name: string;
        property_id: string;
        stock: number;
        status: "open" | "closed" | "suspended";
      }[]
    >`
      select distinct business.id, business.name, business.status,business.property_id::text as property_id,
        coalesce((select sum(on_hand-reserved)::int from business_items i where i.business_id=business.id and i.active=true),0) as stock
      from businesses business
      join properties p on p.id=business.property_id
      left join buildings b on b.business_id = business.id
      where business.active = true and ((b.status <> 'hidden'
        and (b.exterior_scene_id = ${sceneId} or b.interior_scene_id = ${sceneId}))
        or (b.id is null and ${sceneId}='city-district' and p.district='knowledge'))
      order by business.id limit ${MAX_ROWS}
    `;
    const directory = await transaction<{ npc_id: string; scene_id: string; activity: string }[]>`
      select npc_id, scene_id, activity from npc_runtime order by npc_id limit 200
    `;
    const head = await streamHead(transaction, `scene:${sceneId}`);

    return {
      type: "world.bootstrap",
      protocolVersion: PROTOCOL_VERSION,
      serverTime: capturedNow.toISOString(),
      cityTime: capturedCityTime.toISOString(),
      streamId: `scene:${sceneId}`,
      lastSequence: head,
      npcDirectory: directory.map((npc) => ({
        npcId: npc.npc_id,
        sceneId: npc.scene_id,
        activity: npc.activity,
      })),
      movement: options.movement ?? { stepMs: 250, tilesPerTick: 1 },
      scene: {
        id: scene.id,
        name: scene.name,
        sceneType: scene.scene_type,
        width: scene.width,
        height: scene.height,
        assetKey: scene.asset_key,
        assetVersion: scene.asset_version,
      },
      player: { ...me, ...(names.has(accountId) ? { displayName: names.get(accountId)! } : {}) },
      buildings: buildings.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        buildingType: row.building_type,
        entranceX: row.entrance_x,
        entranceY: row.entrance_y,
        entranceFacing: row.entrance_facing as WorldBootstrapType["player"]["facing"],
        status: row.status,
        doorId: worldScenes
          .find((scene) => scene.id === sceneId)
          ?.doors.find((door) => door.x === row.entrance_x && door.y === row.entrance_y)?.id,
        isOpen: row.status === "active" && isVenueOpen(row.operating_hours, capturedNow),
        ...(row.operating_hours?.open &&
        row.operating_hours?.close &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(row.operating_hours.open) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(row.operating_hours.close)
          ? { openingHours: { open: row.operating_hours.open, close: row.operating_hours.close } }
          : {}),
        propertyId: row.property_id,
        businessId: row.business_id,
      })),
      interactionZones: [
        ...buildings.map((row) => ({
          id: row.id,
          kind: "building",
          x: row.entrance_x,
          y: row.entrance_y,
          radius: 2,
        })),
        ...spawns
          .filter((row) => row.kind === "door")
          .map((row) => ({
            id: row.id,
            kind: "door",
            x: row.x,
            y: row.y,
            radius:
              worldScenes.find((item) => item.id === sceneId)?.doors.find((door) => door.id === row.id)
                ?.radius ?? 2,
          })),
        ...npcs.map((npc) => ({ id: npc.npc_id, kind: "npc", x: npc.x, y: npc.y, radius: 2 })),
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
        hasJob: row.has_job,
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
        ...(names.has(row.player_account) ? { displayName: names.get(row.player_account)! } : {}),
        x: row.x,
        y: row.y,
        facing: row.facing as WorldBootstrapType["player"]["facing"],
        stateVersion: row.state_version,
      })),
      properties: properties.map((row) => ({
        id: row.id,
        forSale: row.for_sale,
        condition: row.condition,
        utilitiesActive: row.utilities_active,
        price: row.price,
        ...(scene.scene_type === "exterior" ? { x: row.x, y: row.y } : {}),
      })),
      businesses: businesses.map((row) => ({
        id: row.id,
        name: row.name,
        propertyId: row.property_id,
        stockAvailable: row.stock,
        status: row.status,
      })),
    };
  });
}
