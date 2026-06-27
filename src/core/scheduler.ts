import type { SchedulerConfig } from "./types.js";

export type Scheduler = {
  start: (entityId: string) => Promise<void>;
  stop: (entityId: string) => Promise<void>;
  triggerNow: (entityId: string) => Promise<void>;
  seedFromStore: () => Promise<void>;
};

export const createScheduler = (_config: SchedulerConfig): Scheduler => {
  return {
    start: async (_entityId) => {
      throw new Error("Not implemented");
    },
    stop: async (_entityId) => {
      throw new Error("Not implemented");
    },
    triggerNow: async (_entityId) => {
      throw new Error("Not implemented");
    },
    seedFromStore: async () => {
      throw new Error("Not implemented");
    },
  };
};
