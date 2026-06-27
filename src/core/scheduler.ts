import { clampCadence } from "./cadence.js";
import type { SchedulerConfig, TickTrigger } from "./types.js";

export type Scheduler = {
  start: (entityId: string) => Promise<void>;
  stop: (entityId: string) => Promise<void>;
  triggerNow: (entityId: string) => Promise<void>;
  seedFromStore: () => Promise<void>;
};

export const createScheduler = (config: SchedulerConfig): Scheduler => {
  const { adapter, store, cadence, identity, onTick } = config;

  // Entities with a live loop. Gates re-enqueue so stop() halts cleanly even if
  // a tick is in flight. In-memory: re-seeded by seedFromStore() after restart.
  // ponytail: single-process gate; multi-process scheduling needs a shared lock.
  const active = new Set<string>();

  const fireAndReschedule = async (entityId: string, trigger: TickTrigger) => {
    const result = await onTick(entityId, trigger);
    if (!active.has(entityId)) return; // stopped during the tick — don't re-arm
    const nextMs = clampCadence(result.nextCadenceMs, cadence);
    const jobId = identity(entityId);
    await adapter.enqueue({ entityId, delayMs: nextMs, jobId });
    await store.upsertState(entityId, {
      nextScheduledTickAt: new Date(Date.now() + nextMs),
    });
  };

  // When an enqueued job fires, run the tick and enqueue the next one. The
  // adapter invokes this synchronously, so we detach and route failures to
  // onError rather than leaking an unhandled rejection.
  adapter.onFire((entityId) => {
    fireAndReschedule(entityId, "scheduled").catch((err) => config.onError?.(err, entityId));
  });

  return {
    async start(entityId) {
      active.add(entityId);
      const jobId = identity(entityId);
      await adapter.enqueue({ entityId, delayMs: cadence.default, jobId });
      await store.upsertState(entityId, {
        nextScheduledTickAt: new Date(Date.now() + cadence.default),
      });
    },

    async stop(entityId) {
      active.delete(entityId);
      const jobId = identity(entityId);
      await adapter.remove(jobId);
      await store.upsertState(entityId, { nextScheduledTickAt: null });
    },

    async triggerNow(entityId) {
      active.add(entityId);
      const jobId = identity(entityId);
      await adapter.remove(jobId);
      await fireAndReschedule(entityId, "manual");
    },

    async seedFromStore() {
      const entities = await store.listSchedulableEntities();
      for (const entity of entities) {
        active.add(entity.entityId);
        const jobId = identity(entity.entityId);
        const delayMs = entity.nextScheduledTickAt
          ? Math.max(0, entity.nextScheduledTickAt.getTime() - Date.now())
          : cadence.default;
        await adapter.enqueue({ entityId: entity.entityId, delayMs, jobId });
      }
    },
  };
};
