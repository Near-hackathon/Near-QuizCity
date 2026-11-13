import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryCoordinator, startFallbackRefresh } from "./queries";

describe("query coordinator", () => {
  it("aborts older generations so late responses cannot apply", () => {
    const coordinator = createQueryCoordinator();
    const first = coordinator.begin();
    expect(first.signal.aborted).toBe(false);
    coordinator.reset();
    expect(first.signal.aborted).toBe(true);

    const next = coordinator.begin();
    expect(next.generation).toBe(1);
    expect(next.signal.aborted).toBe(false);
    coordinator.reset();
  });

  it("aborts the previous request when a new one begins", () => {
    const coordinator = createQueryCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    second.finish();
    coordinator.reset();
  });
});

describe("fallback refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses when hidden, offline, or already refreshing and cleans up", async () => {
    let hidden = true;
    let online = true;
    let refreshing = false;
    const refresh = vi.fn(async () => undefined);
    const stop = startFallbackRefresh({
      intervalMs: 1_000,
      isHidden: () => hidden,
      isOnline: () => online,
      isRefreshing: () => refreshing,
      refresh,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).not.toHaveBeenCalled();

    hidden = false;
    online = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).not.toHaveBeenCalled();

    online = true;
    refreshing = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).not.toHaveBeenCalled();

    refreshing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
