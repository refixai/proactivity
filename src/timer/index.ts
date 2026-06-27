import type { SchedulerAdapter } from "../core/types.js";

export type TimerAdapter = SchedulerAdapter & {
  onFire: (handler: (entityId: string) => void) => void;
};

export const createTimerAdapter = (): TimerAdapter => {
  const timers = new Map<string, { timeout: ReturnType<typeof setTimeout>; entityId: string }>();
  let fireHandler: ((entityId: string) => void) | null = null;

  return {
    onFire: (handler) => {
      fireHandler = handler;
    },

    async enqueue({ entityId, delayMs, jobId }) {
      const timeout = setTimeout(() => {
        timers.delete(jobId);
        fireHandler?.(entityId);
      }, delayMs);
      timers.set(jobId, { timeout, entityId });
    },

    async remove(jobId) {
      const entry = timers.get(jobId);
      if (entry) {
        clearTimeout(entry.timeout);
        timers.delete(jobId);
      }
    },

    async reschedule({ jobId, delayMs }) {
      const entry = timers.get(jobId);
      if (!entry) return;
      clearTimeout(entry.timeout);
      const { entityId } = entry;
      const timeout = setTimeout(() => {
        timers.delete(jobId);
        fireHandler?.(entityId);
      }, delayMs);
      timers.set(jobId, { timeout, entityId });
    },
  };
};
