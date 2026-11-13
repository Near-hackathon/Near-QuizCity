import websocket from "@fastify/websocket";
import { Value } from "@sinclair/typebox/value";
import type { WebSocket } from "ws";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Sql } from "postgres";
import {
  WorldClientMessage,
  WorldServerMessage,
  type WorldClientMessageType,
  type WorldServerMessageType,
} from "@quiz-city/protocol";
import type { AppConfig } from "./config.js";
import { sql as globalSql } from "./db.js";
import { buildWorldBootstrap } from "./world-bootstrap.js";
import {
  appendWorldEvents,
  oldestSequence,
  replayAfter,
  streamHead,
  worldEventFromRow,
} from "./world-events.js";
import { startWorker, type WorkerHandle } from "./worker.js";
import { startWorldFanout, type WorldFanout } from "./world-fanout.js";
import { AppError } from "./errors.js";
import { applyInteraction, applyMoveIntent, lockPresence } from "./world-authority.js";

type IntervalHandle = ReturnType<typeof setInterval>;

export type WorldSocketTimers = {
  setInterval: (callback: () => void, milliseconds: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
};

type Client = {
  socket: WebSocket;
  accountId: string;
  sessionId: string;
  ip: string;
  sceneId: string | null;
  streamId: string | null;
  lastSent: string;
  lastAck: string;
  lastClientSequence: string | null;
  commandIds: Map<string, { sequence: string; fingerprint: string; accepted: boolean }>;
  lastPong: number;
  queue: Promise<void>;
  left: boolean;
};

export type WorldSocketDeps = {
  db: Sql;
  now: () => Date;
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  timers?: WorldSocketTimers;
  startFanout?: typeof startWorldFanout;
  startPresenceWorker?: typeof startWorker;
  buildBootstrap?: typeof buildWorldBootstrap;
  bufferedAmount?: (socket: WebSocket) => number;
};

export type WorldSocketRuntime = {
  register(app: FastifyInstance): Promise<void>;
  close(): Promise<void>;
  stats(): { clients: number; streams: number; accounts: number; ips: number };
};

const defaultTimers: WorldSocketTimers = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle),
};

function worldCommandError(error: unknown): { code: string; message: string } {
  if (!(error instanceof AppError)) return { code: "CONFLICT", message: "command rejected" };
  if (error.code === "RATE_LIMITED") return { code: "RATE_LIMITED", message: "command rate limited" };
  if (["INVALID_SCENE", "OUT_OF_RANGE", "TARGET_NOT_FOUND", "TARGET_CLOSED"].includes(error.message)) {
    return { code: error.message, message: "command rejected" };
  }
  if (
    error.message === "duplicate command" ||
    error.message === "message id reused with different command data" ||
    error.message === "stale client sequence" ||
    error.message === "presence changed" ||
    error.message === "presence not found"
  ) {
    return { code: "RESYNC_REQUIRED", message: "world state must be resynchronized" };
  }
  if (error.code === "VALIDATION_ERROR") {
    return { code: "INVALID_DESTINATION", message: "destination rejected" };
  }
  return { code: error.code, message: "command rejected" };
}

export function createWorldSocketRuntime(deps: WorldSocketDeps, cfg: AppConfig): WorldSocketRuntime {
  const timers = deps.timers ?? defaultTimers;
  const clients = new Set<Client>();
  const streams = new Map<string, Set<Client>>();
  const accountCounts = new Map<string, number>();
  const ipCounts = new Map<string, number>();
  let closed = false;
  let registered = false;
  let fanout: WorldFanout | null = null;
  let presence: WorkerHandle | null = null;
  let heartbeat: IntervalHandle | null = null;
  let closePromise: Promise<void> | null = null;

  const send = (client: Client, message: WorldServerMessageType): boolean => {
    if (closed || client.left || client.socket.readyState !== 1) return false;
    if (!Value.Check(WorldServerMessage, message)) {
      throw new Error("invalid outbound world message");
    }
    const bufferedAmount = (deps.bufferedAmount ?? ((socket: WebSocket) => socket.bufferedAmount))(
      client.socket,
    );
    if (bufferedAmount > cfg.worldMaxQueuedBytes) {
      client.socket.close(1013, "slow consumer");
      leave(client, "slow consumer");
      return false;
    }
    client.socket.send(JSON.stringify(message));
    return true;
  };

  const serialize = (client: Client, task: () => Promise<void>): Promise<void> => {
    const next = client.queue.then(task, task);
    client.queue = next.catch(() => undefined);
    return next;
  };

  const decrement = (counts: Map<string, number>, key: string): void => {
    const next = Math.max(0, (counts.get(key) ?? 1) - 1);
    if (next === 0) counts.delete(key);
    else counts.set(key, next);
  };

  const unsubscribe = (client: Client): void => {
    if (client.streamId) {
      const set = streams.get(client.streamId);
      set?.delete(client);
      if (set?.size === 0) streams.delete(client.streamId);
    }
    client.sceneId = null;
    client.streamId = null;
    client.lastSent = "0";
    client.lastAck = "0";
  };

  function leave(client: Client, reason = "leave"): void {
    if (client.left) return;
    client.left = true;
    unsubscribe(client);
    clients.delete(client);
    decrement(accountCounts, client.accountId);
    decrement(ipCounts, client.ip);
    deps.logger.info({ reason }, "world socket left");
  }

  const join = (client: Client, sceneId: string, streamId: string, sequence: string): void => {
    client.sceneId = sceneId;
    client.streamId = streamId;
    client.lastSent = sequence;
    client.lastAck = sequence;
    let members = streams.get(streamId);
    if (!members) {
      members = new Set<Client>();
      streams.set(streamId, members);
    }
    members.add(client);
  };

  const touchPresence = async (client: Client): Promise<boolean> => {
    if (!client.sceneId || client.left) return false;
    const rows = await deps.db<{ session_id: string }[]>`
      update player_presence
      set heartbeat_at = ${deps.now()}
      where session_id = ${client.sessionId}
        and player_account = ${client.accountId}
        and scene_id = ${client.sceneId}
      returning session_id
    `;
    return rows.length === 1;
  };

  const deliverClient = async (client: Client, streamId: string): Promise<boolean> => {
    if (closed || client.left || client.streamId !== streamId) return false;
    const head = await streamHead(deps.db, streamId);
    while (BigInt(client.lastSent) < BigInt(head) && !closed && !client.left) {
      const rows = await replayAfter(deps.db, streamId, client.lastSent, cfg.worldReplayLimit);
      if (rows.length === 0) {
        send(client, { type: "world.resync_required", reason: "stream history is incomplete" });
        unsubscribe(client);
        return false;
      }
      for (const row of rows) {
        if (client.streamId !== streamId) return false;
        if (!send(client, { type: "world.event", event: worldEventFromRow(row) })) return false;
        client.lastSent = row.sequence;
      }
    }
    return !closed && !client.left && client.streamId === streamId;
  };

  const deliverStream = async (streamId: string): Promise<void> => {
    if (!streamId) {
      for (const id of [...streams.keys()]) await deliverStream(id);
      return;
    }
    const set = streams.get(streamId);
    if (!set) return;
    for (const client of [...set]) {
      await serialize(client, () => deliverClient(client, streamId).then(() => undefined)).catch((error) =>
        deps.logger.warn({ err: error }, "world delivery failed"),
      );
    }
  };

  const subscribe = async (client: Client, message: WorldClientMessageType): Promise<void> => {
    if (message.type !== "world.subscribe" || closed || client.left) return;
    const sceneId = message.sceneId;
    const streamId = `scene:${sceneId}`;
    unsubscribe(client);
    const head = await streamHead(deps.db, streamId);

    if (message.lastSequence === null) {
      const bootstrap = await (deps.buildBootstrap ?? buildWorldBootstrap)(
        deps.db,
        client.accountId,
        sceneId,
        {
          now: deps.now,
          sessionId: client.sessionId,
        },
      );
      const claimed = await deps.db<{ session_id: string }[]>`
        insert into player_presence (
          session_id, player_account, scene_id, x, y, facing, heartbeat_at
        ) values (
          ${client.sessionId}, ${client.accountId}, ${sceneId},
          ${bootstrap.player.x}, ${bootstrap.player.y}, ${bootstrap.player.facing}, ${deps.now()}
        )
        on conflict (session_id) do update set
          heartbeat_at = excluded.heartbeat_at
        where player_presence.player_account = excluded.player_account
          and player_presence.scene_id = excluded.scene_id
        returning session_id
      `;
      if (claimed.length !== 1) {
        send(client, {
          type: "world.resync_required",
          reason: "requested scene does not match authoritative presence",
        });
        return;
      }
      if (!send(client, bootstrap)) return;
      join(client, sceneId, streamId, bootstrap.lastSequence);
      if (!(await deliverClient(client, streamId))) return;
      send(client, {
        type: "world.ready",
        streamId,
        sequence: client.lastSent,
        lastClientSequence: bootstrap.player.lastClientSequence,
      });
      return;
    }

    if (BigInt(message.lastSequence) > BigInt(head)) {
      send(client, { type: "world.resync_required", reason: "sequence is ahead of server" });
      return;
    }
    const oldest = await oldestSequence(deps.db, streamId);
    if (oldest && BigInt(message.lastSequence) + 1n < BigInt(oldest)) {
      send(client, { type: "world.resync_required", reason: "sequence history has expired" });
      return;
    }
    const restored = await deps.db<{ session_id: string; last_client_sequence: string }[]>`
      update player_presence
      set heartbeat_at = ${deps.now()}
      where session_id = ${client.sessionId}
        and player_account = ${client.accountId}
        and scene_id = ${sceneId}
      returning session_id, last_client_sequence::text as last_client_sequence
    `;
    if (restored.length !== 1) {
      send(client, { type: "world.resync_required", reason: "session presence is missing" });
      return;
    }
    join(client, sceneId, streamId, message.lastSequence);
    if (!(await deliverClient(client, streamId))) return;
    send(client, {
      type: "world.ready",
      streamId,
      sequence: client.lastSent,
      lastClientSequence: restored[0].last_client_sequence,
    });
  };

  const handle = async (client: Client, raw: string): Promise<void> => {
    if (Buffer.byteLength(raw, "utf8") > cfg.worldSocketMaxPayloadBytes) {
      client.socket.close(1009, "message too large");
      leave(client, "message too large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(client, { type: "world.error", code: "INVALID_JSON", message: "invalid message" });
      return;
    }
    if (!Value.Check(WorldClientMessage, parsed)) {
      send(client, { type: "world.error", code: "INVALID_MESSAGE", message: "invalid message" });
      return;
    }
    const message = parsed as WorldClientMessageType;
    const fingerprint = JSON.stringify(
      Object.fromEntries(Object.entries(message).sort(([left], [right]) => left.localeCompare(right))),
    );
    const prior = client.commandIds.get(message.messageId);
    if (prior) {
      const exact = prior.sequence === message.clientSequence && prior.fingerprint === fingerprint;
      if (
        exact &&
        prior.accepted &&
        (message.type === "world.move_intent" || message.type === "world.interact")
      ) {
        send(client, { type: "world.ack", messageId: message.messageId, sequence: client.lastSent });
        return;
      }
      send(client, {
        type: "world.error",
        code: exact ? "DUPLICATE_COMMAND" : "RESYNC_REQUIRED",
        message: exact
          ? "command was already processed"
          : "message id was reused with different command data",
        messageId: message.messageId,
      });
      return;
    }
    if (
      client.lastClientSequence !== null &&
      BigInt(message.clientSequence) <= BigInt(client.lastClientSequence)
    ) {
      send(client, {
        type: "world.error",
        code: "RESYNC_REQUIRED",
        message: "client sequence must increase",
        messageId: message.messageId,
      });
      return;
    }

    await touchPresence(client);
    let accepted = false;
    switch (message.type) {
      case "world.subscribe":
        await subscribe(client, message);
        break;
      case "world.ack":
        if (
          client.sceneId !== message.sceneId ||
          client.streamId !== `scene:${message.sceneId}` ||
          BigInt(message.sequence) < BigInt(client.lastAck) ||
          BigInt(message.sequence) > BigInt(client.lastSent)
        ) {
          send(client, {
            type: "world.error",
            code: "INVALID_ACK",
            message: "ack does not match the active stream or sent sequence",
            messageId: message.messageId,
          });
          break;
        }
        client.lastAck = message.sequence;
        send(client, { type: "world.ack", messageId: message.messageId, sequence: message.sequence });
        break;
      case "world.ping":
        if (client.sceneId !== message.sceneId) {
          send(client, {
            type: "world.error",
            code: "SCENE_MISMATCH",
            message: "message does not match the active scene",
            messageId: message.messageId,
          });
          break;
        }
        send(client, {
          type: "world.pong",
          messageId: message.messageId,
          serverTime: deps.now().toISOString(),
        });
        break;
      case "world.move_intent":
        try {
          await deps.db.begin(async (transaction) => {
            const presence = await lockPresence(transaction, client.sessionId, client.accountId);
            await applyMoveIntent(transaction, presence, message, {
              now: deps.now(),
              cooldownMs: cfg.worldMoveCooldownMs,
              burst: cfg.worldMoveBurst,
            });
          });
          accepted = true;
          send(client, { type: "world.ack", messageId: message.messageId, sequence: client.lastSent });
        } catch (error) {
          const publicError = worldCommandError(error);
          send(client, {
            type: "world.error",
            code: publicError.code,
            message: publicError.message,
            messageId: message.messageId,
          });
        }
        break;
      case "world.interact":
        try {
          const result = await deps.db.begin(async (transaction) => {
            const presence = await lockPresence(transaction, client.sessionId, client.accountId);
            return applyInteraction(transaction, presence, message, {
              now: deps.now(),
              cooldownMs: cfg.worldInteractionCooldownMs,
              burst: cfg.worldInteractionBurst,
            });
          });
          accepted = true;
          if (result.sceneId !== client.sceneId) {
            unsubscribe(client);
            const bootstrap = await (deps.buildBootstrap ?? buildWorldBootstrap)(
              deps.db,
              client.accountId,
              result.sceneId,
              { now: deps.now, sessionId: client.sessionId },
            );
            if (!send(client, bootstrap)) break;
            join(client, result.sceneId, bootstrap.streamId, bootstrap.lastSequence);
            if (!(await deliverClient(client, bootstrap.streamId))) break;
            send(client, { type: "world.ack", messageId: message.messageId, sequence: client.lastSent });
            send(client, {
              type: "world.ready",
              streamId: bootstrap.streamId,
              sequence: client.lastSent,
              lastClientSequence: message.clientSequence,
            });
          } else {
            send(client, { type: "world.ack", messageId: message.messageId, sequence: client.lastSent });
          }
        } catch (error) {
          const publicError = worldCommandError(error);
          send(client, {
            type: "world.error",
            code: publicError.code,
            message: publicError.message,
            messageId: message.messageId,
          });
        }
        break;
    }

    client.lastClientSequence = message.clientSequence;
    client.commandIds.set(message.messageId, {
      sequence: message.clientSequence,
      fingerprint,
      accepted,
    });
    if (client.commandIds.size > 256) {
      const oldest = client.commandIds.keys().next().value;
      if (oldest !== undefined) client.commandIds.delete(oldest);
    }
  };

  const expirePresence = async (): Promise<void> => {
    const now = deps.now();
    const cutoff = new Date(now.getTime() - cfg.worldPresenceTimeoutMs);
    const expired = (await deps.db.begin(async (transaction) => {
      const [lock] = await transaction<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(hashtextextended('quizcity-world-presence', 0)) as locked
      `;
      if (!lock?.locked) return [];
      const rows = await transaction<
        {
          session_id: string;
          player_account: string;
          scene_id: string;
          x: number;
          y: number;
          facing: "north" | "south" | "east" | "west";
          heartbeat_at: Date;
        }[]
      >`
        delete from player_presence
        where heartbeat_at < ${cutoff}
        returning session_id, player_account, scene_id, x, y, facing, heartbeat_at
      `;
      if (rows.length > 0) {
        await appendWorldEvents(
          transaction,
          rows.map((row) => ({
            streamId: `scene:${row.scene_id}`,
            sceneId: row.scene_id,
            cityTime: now,
            type: "player.left" as const,
            entity: { entityType: "player" as const, entityId: row.player_account },
            payload: {
              accountId: row.player_account,
              x: row.x,
              y: row.y,
              facing: row.facing,
              sceneId: row.scene_id,
            },
            idempotencyKey: `presence-left:${row.session_id}:${row.heartbeat_at.getTime()}`,
          })),
        );
      }
      return rows;
    })) as Array<{ scene_id: string }>;
    if (expired.length > 0) {
      deps.logger.info({ expiredCount: expired.length }, "world presence expired");
    }
  };

  const ensureWorkers = (): void => {
    if (closed) return;
    if (!fanout) {
      fanout = (deps.startFanout ?? startWorldFanout)({
        db: deps.db,
        pollMs: cfg.worldFanoutPollMs,
        onHead: (streamId) => deliverStream(streamId),
        onPoll: () => deliverStream(""),
        onError: (error) => deps.logger.warn({ err: error }, "world fanout failed"),
      });
    }
    if (!presence) {
      presence = (deps.startPresenceWorker ?? startWorker)({
        intervalMs: cfg.worldPresenceTimeoutMs,
        run: expirePresence,
        onError: (error) => deps.logger.warn({ err: error }, "world presence cleanup failed"),
      });
    }
    if (!heartbeat) {
      heartbeat = timers.setInterval(() => {
        const now = deps.now().getTime();
        for (const client of [...clients]) {
          if (now - client.lastPong > cfg.worldHeartbeatTimeoutMs) {
            client.socket.terminate();
            leave(client, "heartbeat timeout");
            continue;
          }
          if (client.socket.readyState === 1) client.socket.ping();
        }
      }, cfg.worldHeartbeatMs);
      heartbeat.unref?.();
    }
  };

  return {
    stats() {
      return {
        clients: clients.size,
        streams: streams.size,
        accounts: accountCounts.size,
        ips: ipCounts.size,
      };
    },
    async register(app) {
      if (registered) throw new Error("world socket runtime is already registered");
      registered = true;
      await app.register(websocket, { options: { maxPayload: cfg.worldSocketMaxPayloadBytes } });
      app.get("/v1/world/ws", { websocket: true }, async (socket: WebSocket, request: FastifyRequest) => {
        if (closed) return socket.close(1001, "server shutting down");
        const origin = request.headers.origin;
        if (!origin || origin !== new URL(cfg.webOrigin).origin) return socket.close(1008, "origin rejected");
        if (!request.auth) return socket.close(1008, "authentication required");
        const accountId = request.auth.accountId;
        const ip = request.ip;
        if (
          (accountCounts.get(accountId) ?? 0) >= cfg.worldMaxSocketsPerAccount ||
          (ipCounts.get(ip) ?? 0) >= cfg.worldMaxSocketsPerIp
        ) {
          return socket.close(1013, "connection limit");
        }
        const client: Client = {
          socket,
          accountId,
          sessionId: request.auth.sessionTokenHash,
          ip,
          sceneId: null,
          streamId: null,
          lastSent: "0",
          lastAck: "0",
          lastClientSequence: null,
          commandIds: new Map(),
          lastPong: deps.now().getTime(),
          queue: Promise.resolve(),
          left: false,
        };
        clients.add(client);
        accountCounts.set(accountId, (accountCounts.get(accountId) ?? 0) + 1);
        ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
        ensureWorkers();
        socket.on("pong", () => {
          client.lastPong = deps.now().getTime();
          void serialize(client, () => touchPresence(client).then(() => undefined)).catch((error) =>
            deps.logger.warn({ err: error }, "world presence heartbeat failed"),
          );
        });
        socket.on("error", (error) => {
          deps.logger.warn({ err: error }, "world socket error");
          leave(client, "socket error");
        });
        socket.on("close", () => leave(client, "disconnect"));
        socket.on("message", (data) => {
          void serialize(client, () => handle(client, data.toString())).catch((error) =>
            deps.logger.warn({ err: error }, "world message failed"),
          );
        });
      });
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        if (heartbeat) timers.clearInterval(heartbeat);
        heartbeat = null;
        await presence?.stop();
        presence = null;
        await fanout?.close();
        fanout = null;
        const queues = [...clients].map((client) => client.queue);
        for (const client of [...clients]) {
          client.socket.close(1001, "server shutting down");
          leave(client, "shutdown");
        }
        await Promise.allSettled(queues);
      })();
      return closePromise;
    },
  };
}

export async function registerWorldSocket(
  app: FastifyInstance,
  cfg: AppConfig,
  overrides: Partial<Omit<WorldSocketDeps, "logger">> = {},
): Promise<WorldSocketRuntime> {
  const runtime = createWorldSocketRuntime(
    {
      db: overrides.db ?? globalSql,
      now: overrides.now ?? (() => new Date()),
      logger: app.log,
      ...overrides,
    },
    cfg,
  );
  await runtime.register(app);
  app.decorate("worldSocket", runtime);
  app.addHook("onClose", async () => {
    await runtime.close();
  });
  return runtime;
}

declare module "fastify" {
  interface FastifyInstance {
    worldSocket: WorldSocketRuntime;
  }
}
