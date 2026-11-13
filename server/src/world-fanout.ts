import type { Sql } from "postgres";
import { startWorker } from "./worker.js";

export type WorldFanout = { close: () => Promise<void> };

export type WorldFanoutOptions = {
  db: Pick<Sql, "listen">;
  channel?: string;
  pollMs: number;
  retryMs?: number;
  onHead: (streamId: string, head: string) => Promise<void> | void;
  onPoll: () => Promise<void> | void;
  onListening?: () => void;
  onError?: (error: unknown) => void;
};

export type WorldFanoutHint = { streamId: string; head: string };

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;
const HINT = /^(scene:[a-z0-9_-]{1,64}):(0|[1-9][0-9]{0,17})$/;

export function parseWorldFanoutHint(payload: string): WorldFanoutHint | null {
  const match = HINT.exec(payload);
  return match ? { streamId: match[1], head: match[2] } : null;
}

/**
 * PostgreSQL LISTEN is a low-latency hint only. The serialized polling callback
 * remains the correctness path after missed notifications or listener reconnects.
 */
export function startWorldFanout(options: WorldFanoutOptions): WorldFanout {
  const channel = options.channel ?? "quizcity_world";
  const retryMs = options.retryMs ?? 1_000;
  if (!CHANNEL.test(channel)) throw new Error("invalid world fan-out channel");
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1) {
    throw new Error("world fan-out poll interval must be a positive integer");
  }
  if (!Number.isSafeInteger(retryMs) || retryMs < 1) {
    throw new Error("world fan-out retry interval must be a positive integer");
  }

  let stopped = false;
  let unlisten: (() => Promise<void> | void) | null = null;
  let listenAttempt: Promise<void> | null = null;
  let retry: NodeJS.Timeout | null = null;
  let closePromise: Promise<void> | null = null;
  const hintedHeads = new Map<string, bigint>();
  const streamTasks = new Map<string, Promise<void>>();

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // An observability callback must never create an unhandled rejection.
    }
  };

  const enqueueHead = (hint: WorldFanoutHint): void => {
    if (stopped) return;
    const head = BigInt(hint.head);
    const previousHead = hintedHeads.get(hint.streamId);
    if (previousHead !== undefined && previousHead >= head) return;
    hintedHeads.set(hint.streamId, head);

    const previous = streamTasks.get(hint.streamId) ?? Promise.resolve();
    const task = previous
      .then(async () => {
        if (!stopped) await options.onHead(hint.streamId, hint.head);
      })
      .catch(report)
      .finally(() => {
        if (streamTasks.get(hint.streamId) === task) streamTasks.delete(hint.streamId);
      });
    streamTasks.set(hint.streamId, task);
  };

  const handle = (payload: string): void => {
    const hint = parseWorldFanoutHint(payload);
    if (hint) enqueueHead(hint);
  };

  const scheduleRetry = (): void => {
    if (stopped || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      void listen();
    }, retryMs);
    retry.unref?.();
  };

  const listen = (): Promise<void> => {
    if (stopped || unlisten) return Promise.resolve();
    if (listenAttempt) return listenAttempt;
    listenAttempt = (async () => {
      try {
        const meta = await options.db.listen(channel, handle, () => {
          if (stopped) return;
          try {
            options.onListening?.();
          } catch (error) {
            report(error);
          }
        });
        if (stopped) {
          await meta.unlisten();
          return;
        }
        unlisten = meta.unlisten;
      } catch (error) {
        report(error);
        if (!stopped) scheduleRetry();
      } finally {
        listenAttempt = null;
      }
    })();
    return listenAttempt;
  };

  const poller = startWorker({
    intervalMs: options.pollMs,
    runImmediately: false,
    run: async () => {
      if (!stopped) await options.onPoll();
    },
    onError: report,
  });
  void listen();

  return {
    close() {
      closePromise ??= (async () => {
        stopped = true;
        if (retry) clearTimeout(retry);
        retry = null;
        await poller.stop();
        if (listenAttempt) await listenAttempt;
        const stopListening = unlisten;
        unlisten = null;
        if (stopListening) {
          try {
            await stopListening();
          } catch (error) {
            report(error);
          }
        }
        await Promise.allSettled([...streamTasks.values()]);
        streamTasks.clear();
        hintedHeads.clear();
      })();
      return closePromise;
    },
  };
}
