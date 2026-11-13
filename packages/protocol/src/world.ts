import { Type, type Static } from "@sinclair/typebox";
import { AccountId, IsoTimestamp, QcAmount, TxHash, safeText } from "./common.js";

export const WORLD_COORDINATE_MIN = -10_000;
export const WORLD_COORDINATE_MAX = 10_000;

export const WorldSequence = Type.String({
  pattern: "^(0|[1-9][0-9]*)$",
  maxLength: 18,
});
export const WorldCoordinate = Type.Integer({
  minimum: WORLD_COORDINATE_MIN,
  maximum: WORLD_COORDINATE_MAX,
});
export const WorldDirection = Type.Union([
  Type.Literal("north"),
  Type.Literal("north_east"),
  Type.Literal("east"),
  Type.Literal("south_east"),
  Type.Literal("south"),
  Type.Literal("south_west"),
  Type.Literal("west"),
  Type.Literal("north_west"),
]);
export const WorldStreamId = Type.String({
  pattern: "^scene:[a-z0-9_-]{1,64}$",
  maxLength: 72,
});
export const WorldEntityRef = Type.Object(
  {
    entityType: Type.Union([
      Type.Literal("player"),
      Type.Literal("npc"),
      Type.Literal("building"),
      Type.Literal("door"),
      Type.Literal("business"),
      Type.Literal("job"),
      Type.Literal("property"),
      Type.Literal("scene"),
    ]),
    entityId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

const worldId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" });
const sceneId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9_-]+$" });
const protocolVersion = Type.String({ minLength: 5, maxLength: 32, pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" });

function entity(entityType: "player" | "npc" | "building" | "door" | "business" | "job" | "property") {
  return Type.Object(
    { entityType: Type.Literal(entityType), entityId: worldId },
    { additionalProperties: false },
  );
}

const envelope = {
  protocolVersion,
  eventId: worldId,
  streamId: WorldStreamId,
  sequence: WorldSequence,
  serverTime: IsoTimestamp,
  cityTime: IsoTimestamp,
  sceneId,
};

export const NpcActivityChangedEvent = Type.Object(
  {
    ...envelope,
    entity: entity("npc"),
    type: Type.Literal("npc.activity_changed"),
    payload: Type.Object(
      {
        activity: Type.String({ minLength: 1, maxLength: 64 }),
        stateVersion: WorldSequence,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const NpcPathStartedEvent = Type.Object(
  {
    ...envelope,
    entity: entity("npc"),
    type: Type.Literal("npc.path_started"),
    payload: Type.Object(
      {
        sceneId,
        toX: WorldCoordinate,
        toY: WorldCoordinate,
        stateVersion: WorldSequence,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const NpcPathCompletedEvent = Type.Object(
  {
    ...envelope,
    entity: entity("npc"),
    type: Type.Literal("npc.path_completed"),
    payload: Type.Object(
      { sceneId, x: WorldCoordinate, y: WorldCoordinate },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const NpcBuildingEvent = Type.Object(
  {
    ...envelope,
    entity: entity("npc"),
    type: Type.Union([Type.Literal("npc.entered_building"), Type.Literal("npc.exited_building")]),
    payload: Type.Object(
      { buildingId: Type.String({ minLength: 1, maxLength: 64 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const DoorStateEvent = Type.Object(
  {
    ...envelope,
    entity: entity("door"),
    type: Type.Literal("door.state_changed"),
    payload: Type.Object(
      {
        doorId: Type.String({ minLength: 1, maxLength: 64 }),
        state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const BusinessStateEvent = Type.Object(
  {
    ...envelope,
    entity: entity("business"),
    type: Type.Literal("business.state_changed"),
    payload: Type.Object(
      {
        businessId: Type.String({ minLength: 1, maxLength: 64 }),
        status: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("suspended")]),
        revenueTotal: QcAmount,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const JobPresentationEvent = Type.Object(
  {
    ...envelope,
    entity: entity("job"),
    type: Type.Literal("job.presentation_changed"),
    payload: Type.Object(
      {
        jobId: Type.String({ minLength: 1, maxLength: 128 }),
        status: Type.Union([
          Type.Literal("open"),
          Type.Literal("accepted"),
          Type.Literal("submitted"),
          Type.Literal("verified"),
          Type.Literal("payment_pending"),
          Type.Literal("payment_unknown"),
          Type.Literal("payment_failed"),
          Type.Literal("paid"),
          Type.Literal("cancelled"),
        ]),
        txHash: Type.Union([TxHash, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const PurchasePresentationEvent = Type.Object(
  {
    ...envelope,
    entity: entity("business"),
    type: Type.Literal("purchase.presentation_changed"),
    payload: Type.Object(
      {
        businessId: Type.String({ minLength: 1, maxLength: 64 }),
        amount: QcAmount,
        status: Type.Union([Type.Literal("pending"), Type.Literal("confirmed"), Type.Literal("failed")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const InventoryPresentationEvent = Type.Object(
  {
    ...envelope,
    entity: entity("player"),
    type: Type.Literal("inventory.presentation_changed"),
    payload: Type.Object(
      {
        accountId: AccountId,
        item: Type.String({ minLength: 1, maxLength: 64 }),
        delta: Type.String({ pattern: "^(0|-?[1-9][0-9]{0,17})$", maxLength: 19 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const PropertyPresentationEvent = Type.Object(
  {
    ...envelope,
    entity: entity("property"),
    type: Type.Literal("property.presentation_changed"),
    payload: Type.Object(
      {
        propertyId: Type.String({ minLength: 1, maxLength: 64 }),
        forSale: Type.Boolean(),
        price: QcAmount,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const PlayerWorldEvent = Type.Object(
  {
    ...envelope,
    entity: entity("player"),
    type: Type.Union([
      Type.Literal("player.joined"),
      Type.Literal("player.checkpoint"),
      Type.Literal("player.left"),
      Type.Literal("player.scene_changed"),
    ]),
    payload: Type.Object(
      {
        accountId: AccountId,
        x: WorldCoordinate,
        y: WorldCoordinate,
        facing: WorldDirection,
        sceneId,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const WorldEvent = Type.Union([
  NpcActivityChangedEvent,
  NpcPathStartedEvent,
  NpcPathCompletedEvent,
  NpcBuildingEvent,
  DoorStateEvent,
  BusinessStateEvent,
  JobPresentationEvent,
  PurchasePresentationEvent,
  InventoryPresentationEvent,
  PropertyPresentationEvent,
  PlayerWorldEvent,
]);

export const SubscribeMessage = Type.Object(
  {
    type: Type.Literal("world.subscribe"),
    messageId: Type.String({ minLength: 1, maxLength: 128 }),
    clientSequence: WorldSequence,
    sceneId,
    lastSequence: Type.Union([WorldSequence, Type.Null()]),
  },
  { additionalProperties: false },
);
export const AckMessage = Type.Object(
  {
    type: Type.Literal("world.ack"),
    messageId: Type.String({ minLength: 1, maxLength: 128 }),
    clientSequence: WorldSequence,
    sceneId,
    sequence: WorldSequence,
  },
  { additionalProperties: false },
);
export const MoveIntentMessage = Type.Object(
  {
    type: Type.Literal("world.move_intent"),
    messageId: Type.String({ minLength: 1, maxLength: 128 }),
    clientSequence: WorldSequence,
    sceneId,
    x: WorldCoordinate,
    y: WorldCoordinate,
  },
  { additionalProperties: false },
);
export const InteractMessage = Type.Object(
  {
    type: Type.Literal("world.interact"),
    messageId: Type.String({ minLength: 1, maxLength: 128 }),
    clientSequence: WorldSequence,
    sceneId,
    targetType: Type.Union([
      Type.Literal("building"),
      Type.Literal("door"),
      Type.Literal("npc"),
      Type.Literal("business"),
    ]),
    targetId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const PingMessage = Type.Object(
  {
    type: Type.Literal("world.ping"),
    messageId: Type.String({ minLength: 1, maxLength: 128 }),
    clientSequence: WorldSequence,
    sceneId,
  },
  { additionalProperties: false },
);
export const WorldClientMessage = Type.Union([
  SubscribeMessage,
  AckMessage,
  MoveIntentMessage,
  InteractMessage,
  PingMessage,
]);

const building = Type.Object(
  {
    id: worldId,
    displayName: safeText(128),
    buildingType: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9_-]+$" }),
    entranceX: WorldCoordinate,
    entranceY: WorldCoordinate,
    entranceFacing: WorldDirection,
    status: Type.Union([Type.Literal("active"), Type.Literal("closed")]),
  },
  { additionalProperties: false },
);
const spawn = Type.Object(
  {
    id: worldId,
    kind: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9_-]+$" }),
    x: WorldCoordinate,
    y: WorldCoordinate,
    facing: WorldDirection,
    destinationSceneId: Type.Union([sceneId, Type.Null()]),
    destinationSpawnId: Type.Union([worldId, Type.Null()]),
  },
  { additionalProperties: false },
);
const npc = Type.Object(
  {
    npcId: worldId,
    sceneId,
    x: WorldCoordinate,
    y: WorldCoordinate,
    activity: Type.String({ minLength: 1, maxLength: 64 }),
    targetX: Type.Union([WorldCoordinate, Type.Null()]),
    targetY: Type.Union([WorldCoordinate, Type.Null()]),
    stateVersion: WorldSequence,
  },
  { additionalProperties: false },
);
const player = Type.Object(
  {
    accountId: AccountId,
    x: WorldCoordinate,
    y: WorldCoordinate,
    facing: WorldDirection,
    stateVersion: WorldSequence,
  },
  { additionalProperties: false },
);
const currentPlayer = Type.Object(
  {
    accountId: AccountId,
    x: WorldCoordinate,
    y: WorldCoordinate,
    facing: WorldDirection,
    stateVersion: WorldSequence,
    lastClientSequence: WorldSequence,
  },
  { additionalProperties: false },
);

export const WorldBootstrap = Type.Object(
  {
    type: Type.Literal("world.bootstrap"),
    protocolVersion,
    serverTime: IsoTimestamp,
    cityTime: IsoTimestamp,
    streamId: WorldStreamId,
    lastSequence: WorldSequence,
    scene: Type.Object(
      {
        id: sceneId,
        name: safeText(128),
        sceneType: Type.Union([Type.Literal("exterior"), Type.Literal("interior")]),
        width: Type.Integer({ minimum: 1, maximum: 10_000 }),
        height: Type.Integer({ minimum: 1, maximum: 10_000 }),
        assetKey: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._/-]+$" }),
        assetVersion: Type.String({ minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9._-]+$" }),
      },
      { additionalProperties: false },
    ),
    player: currentPlayer,
    buildings: Type.Array(building, { maxItems: 500 }),
    interactionZones: Type.Array(
      Type.Object(
        {
          id: worldId,
          kind: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9_-]+$" }),
          x: WorldCoordinate,
          y: WorldCoordinate,
          radius: Type.Integer({ minimum: 0, maximum: 32 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
    spawns: Type.Array(spawn, { maxItems: 500 }),
    npcs: Type.Array(npc, { maxItems: 200 }),
    players: Type.Array(player, { maxItems: 200 }),
    properties: Type.Array(
      Type.Object({ id: worldId, forSale: Type.Boolean(), price: QcAmount }, { additionalProperties: false }),
      { maxItems: 500 },
    ),
    businesses: Type.Array(
      Type.Object(
        {
          id: worldId,
          name: safeText(128),
          status: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("suspended")]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
  },
  { additionalProperties: false },
);

export const WorldEventMessage = Type.Object(
  { type: Type.Literal("world.event"), event: WorldEvent },
  { additionalProperties: false },
);
export const WorldReadyMessage = Type.Object(
  {
    type: Type.Literal("world.ready"),
    streamId: WorldStreamId,
    sequence: WorldSequence,
    lastClientSequence: WorldSequence,
  },
  { additionalProperties: false },
);
export const WorldAckMessage = Type.Object(
  {
    type: Type.Literal("world.ack"),
    messageId: Type.String({ minLength: 1, maxLength: 128 }),
    sequence: WorldSequence,
  },
  { additionalProperties: false },
);
export const WorldResyncMessage = Type.Object(
  { type: Type.Literal("world.resync_required"), reason: safeText(256) },
  { additionalProperties: false },
);
export const WorldErrorMessage = Type.Object(
  {
    type: Type.Literal("world.error"),
    code: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z0-9_]+$" }),
    message: safeText(512),
    messageId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export const WorldPongMessage = Type.Object(
  {
    type: Type.Literal("world.pong"),
    messageId: Type.String({ minLength: 1, maxLength: 128 }),
    serverTime: IsoTimestamp,
  },
  { additionalProperties: false },
);
export const WorldServerMessage = Type.Union([
  WorldBootstrap,
  WorldEventMessage,
  WorldReadyMessage,
  WorldAckMessage,
  WorldResyncMessage,
  WorldErrorMessage,
  WorldPongMessage,
]);

export function assertNeverWorldEvent(event: never): never {
  throw new Error(`Unhandled world event: ${JSON.stringify(event)}`);
}

export type WorldSequenceType = Static<typeof WorldSequence>;
export type WorldEventType = Static<typeof WorldEvent>;
export type WorldClientMessageType = Static<typeof WorldClientMessage>;
export type WorldServerMessageType = Static<typeof WorldServerMessage>;
export type WorldBootstrapType = Static<typeof WorldBootstrap>;
