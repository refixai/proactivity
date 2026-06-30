export { createTestStore } from "../memory/index.js";
export { createScheduler, type Scheduler } from "./scheduler.js";
export { assembleBriefing } from "./briefing.js";
export { createHeartbeat, createPlanActHeartbeat, type Heartbeat } from "./heartbeat.js";

// Governance as a standalone primitive — so a consumer driving its own loop
// (e.g. the OpenClaw plugin) can wrap outbound actions in the same envelope the
// heartbeat uses, instead of reimplementing it.
export { createGovernance } from "./governance.js";
export { createLedger, type Ledger } from "./ledger.js";
export { validateGoalMutations } from "./goals.js";

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
