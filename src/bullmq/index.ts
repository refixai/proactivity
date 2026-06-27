import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { SchedulerAdapter } from "../core/types.js";

export type BullMQAdapterConfig = {
  queueName: string;
  connection: ConnectionOptions;
};

export type BullMQAdapter = SchedulerAdapter & {
  close: () => Promise<void>;
};

// BullMQ rejects custom job ids containing ":" (its Redis key separator).
// Consumers namespace identities with colons ("heartbeat:e1"), so normalize.
const safeJobId = (jobId: string) => jobId.replace(/:/g, "-");

export const createBullMQAdapter = (config: BullMQAdapterConfig): BullMQAdapter => {
  const queue = new Queue(config.queueName, { connection: config.connection });
  let worker: Worker | null = null;
  let fireHandler: ((entityId: string) => void) | null = null;

  return {
    onFire(handler) {
      fireHandler = handler;
      // Fire on "completed", not inside the processor: by the time this event
      // emits, removeOnComplete has freed the jobId, so the handler's re-enqueue
      // of the same id isn't deduped against the still-present old job.
      worker = new Worker(config.queueName, async () => {}, { connection: config.connection });
      worker.on("completed", (job) => { fireHandler?.(job.data.entityId); });
    },

    async enqueue({ entityId, delayMs, jobId }) {
      // removeOnComplete/Fail frees the jobId so the self-rescheduling loop can
      // re-add the same id next tick — BullMQ dedupes against retained jobs.
      await queue.add("tick", { entityId }, { jobId: safeJobId(jobId), delay: delayMs, removeOnComplete: true, removeOnFail: true });
    },

    async remove(jobId) {
      const job = await queue.getJob(safeJobId(jobId));
      if (!job) return;
      try {
        await job.remove();
      } catch {
        // ponytail: job is active (locked) — it auto-removes on completion
        // (removeOnComplete) and the scheduler's gate blocks re-enqueue, so
        // stop() still halts the loop. Nothing to do.
      }
    },

    async close() {
      await worker?.close();
      await queue.close();
    },
  };
};
