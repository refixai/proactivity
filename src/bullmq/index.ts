import type { SchedulerAdapter } from "../core/types.js";

export type BullMQAdapterConfig = {
  queueName: string;
  connection: { host: string; port: number };
};

export const createBullMQAdapter = (_config: BullMQAdapterConfig): SchedulerAdapter => {
  throw new Error("Not implemented");
};
