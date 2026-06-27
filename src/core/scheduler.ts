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
    const nextMs = clampCadence(result.nextCadenceMs, cadence);
    const jobId = identity(entityId);
    await adapter.enqueue({ entityId, delayMs: nextMs, jobId });
    await store.upsertState(entityId, {
      nextScheduledTickAt: new Date(Date.now() + nextMs),
    });
  };

  return {
    async start(entityId) {
      const jobId = identity(entityId);
      await adapter.enqueue({ entityId, delayMs: cadence.default, jobId });
      await store.upsertState(entityId, {
        nextScheduledTickAt: new Date(Date.now() + cadence.default),
      });
    },

    async stop(entityId) {
      const jobId = identity(entityId);
      await adapter.remove(jobId);
      await store.upsertState(entityId, { nextScheduledTickAt: null });
    },

    async triggerNow(entityId) {
      const jobId = identity(entityId);
      await adapter.remove(jobId);
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
