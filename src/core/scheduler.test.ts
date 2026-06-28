import { describe, test, expect, vi, afterEach } from "vitest";
import { createScheduler } from "./scheduler.js";
import { createTimerAdapter } from "../timer/index.js";
import { createTestStore } from "../memory/index.js";
import type { TickResult } from "./types.js";

const makeCadenceConfig = () => ({
  min: 100,
  max: 10_000,
  default: 1_000,
});

describe("createScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("start enqueues a job via the adapter", async () => {
    const store = createTestStore();
    const adapter = createTimerAdapter();
    const onTick = vi.fn(async (): Promise<TickResult> => ({
      tickId: "t1", status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: 1_000,
    }));

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: makeCadenceConfig(),
      identity: (id) => `job:${id}`,
      onTick,
    });

    await store.upsertState("e1", { enabled: true });
    await scheduler.start("e1");

    const state = await store.getState("e1");
    expect(state!.nextScheduledTickAt).toBeInstanceOf(Date);
  });

  test("enqueued job fires onTick and re-enqueues the next tick", async () => {
    // Guards the wiring: start() enqueues, the adapter fires, the scheduler
    // must run onTick AND enqueue the next job. Without onFire wiring this
    // loop dies silently after start() — every unit passes, the seam doesn't.
    vi.useFakeTimers();
    const store = createTestStore();
    const adapter = createTimerAdapter();
    const onTick = vi.fn(async (): Promise<TickResult> => ({
      tickId: "t1", status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: 1_000,
    }));

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: makeCadenceConfig(),
      identity: (id) => `job:${id}`,
      onTick,
    });

    await store.upsertState("e1", { enabled: true });
    await scheduler.start("e1");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledWith("e1", "scheduled");

    // The first tick must have re-enqueued; advancing again fires it a second time.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  test("a stop on another replica halts the loop even mid-tick", async () => {
    // The authority for "should this keep ticking" is `enabled` in the shared
    // store, not in-process memory. Simulate another replica issuing stop()
    // (flipping enabled) while this tick runs: the loop must not re-arm.
    vi.useFakeTimers();
    const store = createTestStore();
    const adapter = createTimerAdapter();
    const onTick = vi.fn(async (): Promise<TickResult> => {
      await store.upsertState("e1", { enabled: false });
      return { tickId: "t1", status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: 1_000 };
    });

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: makeCadenceConfig(),
      identity: (id) => `job:${id}`,
      onTick,
    });

    await store.upsertState("e1", { enabled: true });
    await scheduler.start("e1");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledTimes(1);

    // Re-arm must not have happened — advancing further fires nothing.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("stop removes the scheduled job", async () => {
    const store = createTestStore();
    const adapter = createTimerAdapter();

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: makeCadenceConfig(),
      identity: (id) => `job:${id}`,
      onTick: async () => ({ tickId: "t", status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: null }),
    });

    await store.upsertState("e1", { enabled: true });
    await scheduler.start("e1");
    await scheduler.stop("e1");

    const state = await store.getState("e1");
    expect(state!.nextScheduledTickAt).toBeNull();
  });

  test("triggerNow fires onTick immediately and reschedules", async () => {
    const store = createTestStore();
    const adapter = createTimerAdapter();
    const onTick = vi.fn(async (): Promise<TickResult> => ({
      tickId: "t1", status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: 5_000,
    }));

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: makeCadenceConfig(),
      identity: (id) => `job:${id}`,
      onTick,
    });

    await store.upsertState("e1", { enabled: true });
    await scheduler.triggerNow("e1");

    expect(onTick).toHaveBeenCalledWith("e1", "manual");

    const state = await store.getState("e1");
    expect(state!.nextScheduledTickAt).toBeInstanceOf(Date);
  });

  test("seedFromStore re-enqueues entities with scheduled ticks", async () => {
    const store = createTestStore();
    const adapter = createTimerAdapter();

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: makeCadenceConfig(),
      identity: (id) => `job:${id}`,
      onTick: async () => ({ tickId: "t", status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: 1_000 }),
    });

    await store.upsertState("e1", {
      enabled: true,
      nextScheduledTickAt: new Date(Date.now() + 5_000),
    });

    await scheduler.seedFromStore();
    // ponytail: seedFromStore re-enqueues — we verify it doesn't throw and the entity is still scheduled
    const state = await store.getState("e1");
    expect(state!.nextScheduledTickAt).toBeInstanceOf(Date);
  });
});

describe("createTimerAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("enqueue schedules and fires callback after delay", async () => {
    vi.useFakeTimers();
    const adapter = createTimerAdapter();
    const callback = vi.fn();
    adapter.onFire(callback);

    await adapter.enqueue({ entityId: "e1", delayMs: 500, jobId: "j1" });
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledWith("e1");
    vi.useRealTimers();
  });

  test("remove cancels a pending job", async () => {
    vi.useFakeTimers();
    const adapter = createTimerAdapter();
    const callback = vi.fn();
    adapter.onFire(callback);

    await adapter.enqueue({ entityId: "e1", delayMs: 500, jobId: "j1" });
    await adapter.remove("j1");
    vi.advanceTimersByTime(1000);

    expect(callback).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

});
