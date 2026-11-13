type Generation = number;

export type QueryCoordinator = {
  generation(): Generation;
  begin(): { signal: AbortSignal; generation: Generation; finish(): void };
  reset(): void;
};

export function createQueryCoordinator(): QueryCoordinator {
  let generation = 0;
  let controller: AbortController | null = null;

  return {
    generation: () => generation,
    begin() {
      controller?.abort();
      const nextController = new AbortController();
      controller = nextController;
      const current = generation;
      return {
        signal: nextController.signal,
        generation: current,
        finish() {
          if (current === generation && controller === nextController) controller = null;
        },
      };
    },
    reset() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

export type FallbackOptions = {
  intervalMs?: number;
  isHidden: () => boolean;
  isOnline: () => boolean;
  isRefreshing: () => boolean;
  refresh: () => Promise<void>;
};

/** Targeted fallback refresh: paused while hidden/offline/refreshing. */
export function startFallbackRefresh(options: FallbackOptions): () => void {
  const interval = options.intervalMs ?? 20_000;
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight || options.isHidden() || !options.isOnline() || options.isRefreshing()) return;
    inFlight = true;
    options
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, interval);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
