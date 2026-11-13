export type ShutdownOptions = {
  timeoutMs: number;
  app: { close(): Promise<unknown> };
  stop: Array<() => void | Promise<void>>;
  closeDb: () => Promise<void>;
  onError?: (error: unknown) => void;
};

/** Idempotent graceful shutdown: stops timers, closes Fastify, then the DB. */
export function createShutdown(options: ShutdownOptions): (reason?: string) => Promise<void> {
  let started: Promise<void> | null = null;
  return (reason = "shutdown") => {
    if (started) return started;
    started = (async () => {
      try {
        await Promise.race([
          (async () => {
            for (const stop of options.stop) {
              try {
                await stop();
              } catch (error) {
                options.onError?.(error);
              }
            }
            await options.app.close();
          })(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`shutdown timed out after ${options.timeoutMs}ms (${reason})`)),
              options.timeoutMs,
            ),
          ),
        ]);
      } catch (error) {
        options.onError?.(error);
      } finally {
        try {
          await options.closeDb();
        } catch (error) {
          options.onError?.(error);
        }
      }
    })();
    return started;
  };
}
