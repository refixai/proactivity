import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { SchedulerAdapter } from "../core/types.js";

export type BullMQAdapterConfig = {
  queueName: string;
  connection: ConnectionOptions;
};

export type BullMQAdapter = SchedulerAdapter & {
  onFire: (handler: (entityId: string) => void) => void;
  close: () => Promise<void>;
};

export const createBullMQAdapter = (config: BullMQAdapterConfig): BullMQAdapter => {
  const queue = new Queue(config.queueName, { connection: config.connection });
  let worker: Worker | null = null;
  let fireHandler: ((entityId: string) => void) | null = null;

  return {
    onFire(handler) {
      fireHandler = handler;
      worker = new Worker(
        config.queueName,
        async (job) => { fireHandler?.(job.data.entityId); },
        { connection: config.connection },
      );
    },

    async enqueue({ entityId, delayMs, jobId }) {
      await queue.add("tick", { entityId }, { jobId, delay: delayMs });
    },

    async remove(jobId) {
      const job = await queue.getJob(jobId);
      if (job) await job.remove();
    },

    async reschedule({ jobId, delayMs }) {
      const job = await queue.getJob(jobId);
      if (!job) return;
      await job.changeDelay(delayMs);
    },

    async close() {
      await worker?.close();
      await queue.close();
    },
  };
};
