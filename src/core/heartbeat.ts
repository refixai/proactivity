import type {
  HeartbeatConfig,
  PlanActConfig,
  TickResult,
  TickTrigger,
} from "./types.js";

export type Heartbeat = {
  runTick: (entityId: string, trigger: TickTrigger) => Promise<TickResult>;
};

export const createHeartbeat = (_config: HeartbeatConfig): Heartbeat => {
  return {
    runTick: async (_entityId, _trigger) => {
      throw new Error("Not implemented");
    },
  };
};

export const createPlanActHeartbeat = (_config: PlanActConfig): Heartbeat => {
  return {
    runTick: async (_entityId, _trigger) => {
      throw new Error("Not implemented");
    },
  };
};
