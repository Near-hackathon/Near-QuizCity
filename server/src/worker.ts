export type WorkerStatus = {
  running: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
};

export type WorkerHandle = {
  stop(): Promise<void>;
  status(): WorkerStatus;
};

export type WorkerOptions = {
  intervalMs: number;
  maxBackoffMs?: number;
  /** Defaults to true so a restarted server catches up immediately. */
  runImmediately?: boolean;
  random?: () => number;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
};

/** Exponential backoff with jitter, with the maximum applied last. */
export function nextBackoffDelay(
  currentDelay: number,
  intervalMs: number,
  maxBackoffMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxBackoffMs, Math.max(intervalMs, currentDelay * 2));
  const jitter = Math.floor(random() * Math.max(1, Math.min(intervalMs, exponential * 0.2 + 1)));
  return Math.min(maxBackoffMs, exponential + jitter);
}

/** Bounded, overlap-safe worker loop with exponential backoff and jitter. */
export function startWorker(options: WorkerOptions): WorkerHandle {
  const maxBackoff = options.maxBackoffMs ?? 5 * 60_000;
  const random = options.random ?? Math.random;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let delay = options.intervalMs;
  let lastSuccessAt: string | null = null;
  let lastErrorAt: string | null = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      try {
        await options.run();
        lastSuccessAt = new Date().toISOString();
        delay = options.intervalMs;
      } catch (error) {
        lastErrorAt = new Date().toISOString();
        options.onError?.(error);
        delay = nextBackoffDelay(delay, options.intervalMs, maxBackoff, random);
      } finally {
        inFlight = null;
        schedule();
      }
    })();
    await inFlight;
  };

  if (options.runImmediately === false) {
    schedule();
  } else {
    void tick();
  }
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight;
    },
    status() {
      return { running: inFlight !== null, lastSuccessAt, lastErrorAt };
    },
  };
}
