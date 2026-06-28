export { createTestStore } from "../memory/index.js";
export { createScheduler, type Scheduler } from "./scheduler.js";
export { assembleBriefing } from "./briefing.js";
export { createHeartbeat, createPlanActHeartbeat, type Heartbeat } from "./heartbeat.js";

export type {
  SchedulerConfig,
  TickRecord,
  TickResult,
  TickStatus,
  TickTrigger,
  BriefingBoundary,
  BriefingSource,
  GoalRecord,
  GoalMutation,
  GoalMutationOp,
  GoalStatus,
  GoalPriority,
  GovernanceOutcome,
  GovernanceConfig,
  GovernanceCaps,
  GovernanceHandle,
  DispatchResult,
  DispatchRequest,
  ActionAttempt,
  PlanOutput,
  PassResult,
  CadenceHint,
  EntityState,
  SoftCap,
  HeartbeatConfig,
  PlanActConfig,
  TickContext,
  PlannerContext,
  ExecutorContext,
  TickCallbackResult,
  CadenceConfig,
} from "./types.js";

// Extension points. Implement these only to plug in your own backend:
// ProactivityStore for a custom database (the Insert*/Patch types are its
// method payloads), SchedulerAdapter for a custom queue. The bundled
// `./postgres`, `./bullmq`, and `createTestStore` cover the common cases.
export type {
  ProactivityStore,
  SchedulerAdapter,
  InsertTick,
  InsertTickResult,
  TickPatch,
  InsertGoalTick,
  InsertAttempt,
  InsertAttemptResult,
} from "./types.js";
