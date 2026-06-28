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

  const fireAndReschedule = async (entityId: string, trigger: TickTrigger) => {
    const result = await onTick(entityId, trigger);
    // Re-arm only if still enabled. stop() flips `enabled` in the shared store,
    // so this is authoritative across replicas — a stop on any node halts the
    // loop. The heartbeat never writes `enabled`, so an in-flight tick can't
    // resurrect a stopped entity. (Firing itself is single-delivery via the
    // adapter — BullMQ locks each job to one worker.)
    // ponytail: read-then-enqueue isn't atomic — a stop racing this line lets at
    // most one more tick fire before the next re-arm sees enabled=false.
    const state = await store.getState(entityId);
    if (!state?.enabled) return;
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
      const jobId = identity(entityId);
      await adapter.enqueue({ entityId, delayMs: cadence.default, jobId });
      await store.upsertState(entityId, {
        enabled: true,
        nextScheduledTickAt: new Date(Date.now() + cadence.default),
      });
    },

    async stop(entityId) {
      const jobId = identity(entityId);
      await adapter.remove(jobId);
      await store.upsertState(entityId, { enabled: false, nextScheduledTickAt: null });
    },

    async triggerNow(entityId) {
      const jobId = identity(entityId);
      await adapter.remove(jobId);
      await store.upsertState(entityId, { enabled: true });
      await fireAndReschedule(entityId, "manual");
    },

    async seedFromStore() {
      const entities = await store.listSchedulableEntities();
      for (const entity of entities) {
        const jobId = identity(entity.entityId);
        const delayMs = entity.nextScheduledTickAt
          ? Math.max(0, entity.nextScheduledTickAt.getTime() - Date.now())
          : cadence.default;
        await adapter.enqueue({ entityId: entity.entityId, delayMs, jobId });
      }
    },
  };
};
