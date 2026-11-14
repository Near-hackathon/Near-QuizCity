import { Value } from "@sinclair/typebox/value";
import {
  PROTOCOL_VERSION,
  WorldServerMessage,
  type WorldServerMessageType,
  type WorldEventType,
  type WorldClientMessageType,
} from "@quiz-city/protocol";
import { browserApiBase } from "../api-base";

export type WorldStatus = "offline" | "connecting" | "online" | "reconnecting" | "resyncing";

export type WorldTransport = {
  connect(sceneId: string, lastSequence: string | null): void;
  sendMove(x: number, y: number): Promise<string>;
  sendInteract(targetType: "building" | "door" | "npc" | "business", targetId: string): Promise<string>;
  onMessage(listener: (message: WorldServerMessageType) => void): () => void;
  onEvent(listener: (event: WorldEventType) => void): () => void;
  onStatus(listener: (status: WorldStatus) => void): () => void;
  lastSequence(): string | null;
  disconnect(): void;
};

type Options = {
  apiBase?: string;
  socketFactory?: (url: string) => WebSocket;
  random?: () => number;
};

function websocketUrl(base: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/world/ws";
  url.search = "";
  return url.toString();
}

export function createWorldTransport(options: Options = {}): WorldTransport {
  const apiBase = options.apiBase ?? browserApiBase();
  const factory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const random = options.random ?? Math.random;
  const messageListeners = new Set<(message: WorldServerMessageType) => void>();
  const eventListeners = new Set<(event: WorldEventType) => void>();
  const statusListeners = new Set<(status: WorldStatus) => void>();
  const pending = new Map<
    string,
    { resolve: (id: string) => void; reject: (error: Error) => void; timeout: number }
  >();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let sceneId: string | null = null;
  let sequence: string | null = null;
  let clientSequence = 0n;
  let messageId = 0;
  // Receipts survive reloads; a new transport must never reuse c1/c2/... IDs.
  const commandNamespace = crypto.randomUUID();
  let status: WorldStatus = "offline";

  const setStatus = (next: WorldStatus) => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };

  const send = (message: WorldClientMessageType) => {
    if (!socket || socket.readyState !== 1) throw new Error("world transport is offline");
    socket.send(JSON.stringify(message));
  };

  const request = (make: (id: string) => WorldClientMessageType, message?: string): Promise<string> => {
    if (pending.size >= 100) return Promise.reject(new Error("too many pending world commands"));
    const id = `${commandNamespace}:c${++messageId}`;
    try {
      send(make(id));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (pending.delete(id)) reject(new Error(message ?? "world command timed out"));
      }, 10_000);
      pending.set(id, { resolve, reject, timeout });
    });
  };

  const rejectPending = (reason: string) => {
    for (const [, waiting] of pending) {
      clearTimeout(waiting.timeout);
      waiting.reject(new Error(reason));
    }
    pending.clear();
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    reconnectAttempt += 1;
    const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt + Math.floor(random() * 250));
    setStatus("reconnecting");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (!stopped && sceneId) open(sceneId, sequence);
    }, delay);
  };

  const open = (targetScene: string, lastSequence: string | null) => {
    sceneId = targetScene;
    setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const ws = factory(websocketUrl(apiBase));
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      const id = `${commandNamespace}:c${++messageId}`;
      clientSequence += 1n;
      ws.send(
        JSON.stringify({
          type: "world.subscribe",
          messageId: id,
          clientSequence: String(clientSequence),
          sceneId: targetScene,
          lastSequence: lastSequence === null ? null : lastSequence,
        }),
      );
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        ws.close(1003, "invalid json");
        return;
      }
      if (!Value.Check(WorldServerMessage, parsed)) {
        ws.close(1003, "invalid message");
        return;
      }
      const message = parsed as WorldServerMessageType;
      const incomingVersion =
        message.type === "world.event"
          ? message.event.protocolVersion
          : message.type === "world.bootstrap"
            ? message.protocolVersion
            : null;
      if (incomingVersion && incomingVersion.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
        stopped = true;
        setStatus("offline");
        ws.close(1002, "protocol version mismatch");
        return;
      }
      for (const listener of messageListeners) listener(message);
      if (message.type === "world.event") {
        if (message.event.streamId !== `scene:${sceneId}` || message.event.sceneId !== sceneId) {
          setStatus("resyncing");
          sequence = null;
          ws.close(1012, "wrong scene stream");
          return;
        }
        const current = sequence;
        if (current !== null && BigInt(message.event.sequence) > BigInt(current) + 1n) {
          setStatus("resyncing");
          sequence = null;
          ws.close(1012, "sequence gap");
          return;
        }
        if (current === null || BigInt(message.event.sequence) > BigInt(current)) {
          sequence = message.event.sequence;
          for (const listener of eventListeners) listener(message.event);
        }
      } else if (message.type === "world.bootstrap") {
        if (message.streamId !== `scene:${message.scene.id}`) {
          setStatus("resyncing");
          sequence = null;
          ws.close(1012, "invalid bootstrap stream");
          return;
        }
        sceneId = message.scene.id;
        sequence = message.lastSequence;
        if (BigInt(message.player.lastClientSequence) > clientSequence) {
          clientSequence = BigInt(message.player.lastClientSequence);
        }
      } else if (message.type === "world.ready") {
        if (message.streamId !== `scene:${sceneId}` || sequence === null || message.sequence !== sequence) {
          setStatus("resyncing");
          sequence = null;
          ws.close(1012, "invalid ready barrier");
          return;
        }
        sequence = message.sequence;
        if (BigInt(message.lastClientSequence) > clientSequence) {
          clientSequence = BigInt(message.lastClientSequence);
        }
        reconnectAttempt = 0;
        setStatus("online");
      } else if (message.type === "world.resync_required") {
        setStatus("resyncing");
        sequence = null;
        if (message.sceneId) sceneId = message.sceneId;
        ws.close(1012, "resync");
      } else if (message.type === "world.ack") {
        const waiting = pending.get(message.messageId);
        if (waiting) {
          pending.delete(message.messageId);
          clearTimeout(waiting.timeout);
          waiting.resolve(message.messageId);
        }
      } else if (message.type === "world.error") {
        const waiting = message.messageId ? pending.get(message.messageId) : undefined;
        if (waiting && message.messageId) {
          pending.delete(message.messageId);
          clearTimeout(waiting.timeout);
          waiting.reject(new Error(message.code));
        }
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      rejectPending("world transport closed");
      if (event.code === 1008 || event.code === 1002) {
        stopped = true;
        setStatus("offline");
        return;
      }
      if (!stopped) scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  };

  return {
    connect(targetScene, last) {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const previous = socket;
      socket = null;
      previous?.close(1000, "world subscription replaced");
      rejectPending("world subscription replaced");
      stopped = false;
      reconnectAttempt = 0;
      sequence = last;
      open(targetScene, last);
    },
    sendMove(x, y) {
      const scene = sceneId;
      if (!scene) return Promise.reject(new Error("not subscribed"));
      return request(
        (id) => ({
          type: "world.move_intent",
          messageId: id,
          clientSequence: String(++clientSequence),
          sceneId: scene,
          x,
          y,
        }),
        "move intent timed out",
      );
    },
    sendInteract(targetType, targetId) {
      const scene = sceneId;
      if (!scene) return Promise.reject(new Error("not subscribed"));
      return request(
        (id) => ({
          type: "world.interact",
          messageId: id,
          clientSequence: String(++clientSequence),
          sceneId: scene,
          targetType,
          targetId,
        }),
        "interaction timed out",
      );
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },
    lastSequence: () => sequence,
    disconnect() {
      stopped = true;
      sceneId = null;
      sequence = null;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectPending("world transport disconnected");
      socket?.close(1000, "client disconnect");
      socket = null;
      setStatus("offline");
    },
  };
}
