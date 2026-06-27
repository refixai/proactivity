import type { SchedulerAdapter } from "../core/types.js";

export const createTimerAdapter = (): SchedulerAdapter => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
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
      timers.set(jobId, timeout);
    },

    async remove(jobId) {
      const timeout = timers.get(jobId);
      if (timeout) {
        clearTimeout(timeout);
        timers.delete(jobId);
      }
    },
  };
};
