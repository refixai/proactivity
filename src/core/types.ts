// --- Tick ---

export type TickTrigger = "scheduled" | "manual";
export type TickStatus = "running" | "completed" | "failed";

export type TickRecord = {
  id: string;
  entityId: string;
  tickNumber: number;
  trigger: TickTrigger;
  dryRun: boolean;
  status: TickStatus;
  startedAt: Date;
  completedAt: Date | null;
  goalsWorkedCount: number;
  actionsTakenCount: number;
  cadenceHintMs: number | null;
  error: string | null;
};

export type TickResult = {
  tickId: string;
  status: "completed" | "failed";
  goalsWorkedCount: number;
  actionsTakenCount: number;
  nextCadenceMs: number | null;
};

export type InsertTick = {
  entityId: string;
  tickNumber: number;
  trigger: TickTrigger;
  dryRun: boolean;
};

export type TickPatch = Partial<
  Pick<
    TickRecord,
    | "status"
    | "completedAt"
    | "goalsWorkedCount"
    | "actionsTakenCount"
    | "cadenceHintMs"
    | "error"
  >
>;

// --- Briefing ---

export type BriefingBoundary = {
  entityId: string;
  tickId: string;
  tickNumber: number;
  startedAt: Date;
  previousTickStartedAt: Date | null;
  deltaCutoff: Date;
};

export type BriefingSource<T = unknown> = {
  name: string;
  load: (boundary: BriefingBoundary) => Promise<T>;
};

// --- Goals ---

export type GoalStatus = "active" | "paused" | "completed" | "archived";
export type GoalPriority = "low" | "medium" | "high" | "critical";
export type GoalMutationOp =
  | "create"
  | "update"
  | "reprioritize"
  | "pause"
  | "complete"
  | "archive";

export type GoalRecord = {
  id: string;
  entityId: string;
  title: string;
  objective: string;
  doneCondition: string;
  findings: string;
  nextActions: string | null;
  creationReasoning: string;
  status: GoalStatus;
  priority: GoalPriority;
  lastWorkedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GoalMutation = {
  op: GoalMutationOp;
  goalId?: string;
  title?: string;
  objective?: string;
  doneCondition?: string;
  findings?: string;
  nextActions?: string;
  priority?: GoalPriority;
  reasoning: string;
};

export type InsertGoalTick = {
  goalId: string;
  tickId: string;
  orderIndex: number;
};

// --- Governance ---

export type GovernanceOutcome =
  | "taken"
  | "hard_denied"
  | "soft_cap_overridden"
  | "pending_approval"
  | "denied_by_admin";

export type ActionAttempt = {
  id: string;
  goalId: string;
  tickId: string;
  goalTickId: string;
  actionType: string;
  idempotencyKey: string;
  governanceOutcome: GovernanceOutcome;
  reasoning: string;
  denialReason: string | null;
  overrideReason: string | null;
  target: Record<string, unknown>;
  payload: unknown | null;
  attemptedAt: Date;
  completedAt: Date | null;
  error: string | null;
};

export type InsertAttempt = {
  goalId: string;
  tickId: string;
  goalTickId: string;
  actionType: string;
  idempotencyKey: string;
  governanceOutcome: GovernanceOutcome;
  reasoning: string;
  denialReason: string | null;
  overrideReason: string | null;
  target: Record<string, unknown>;
  payload: unknown | null;
};

export type InsertAttemptResult =
  | { kind: "inserted"; attemptId: string }
  | {
      kind: "idempotency_conflict";
      prior: { attemptId: string; outcome: GovernanceOutcome };
    };

export type DispatchResult = {
  governanceOutcome: GovernanceOutcome;
  attemptId: string;
  idempotencyKey: string;
  denialReason?: string;
  overrideReason?: string;
};

export type DispatchRequest = {
  goalId: string;
  goalTickId: string;
  actionType: string;
  target: Record<string, unknown>;
  payload?: unknown;
  reasoning: string;
  overrideReason?: string;
  perform: () => Promise<void>;
};

// --- Plan/Act ---

export type CadenceHint = {
  nextTickMs: number;
  reasoning: string;
};

export type PlanOutput = {
  goalMutations: GoalMutation[];
  selectedGoals: Array<{ goalId: string; reasoning: string }>;
  skippedGoals: Array<{ goalId: string; reasoning: string }>;
  cadenceHint?: CadenceHint;
};

export type PassResult = {
  acted: boolean;
  summary: string;
  skipReason?: string;
};

// --- Entity State ---

export type EntityState = {
  entityId: string;
  enabled: boolean;
  actionsRequireApproval: boolean;
  lastTickAt: Date | null;
  nextScheduledTickAt: Date | null;
};

// --- Storage ---

export type ProactivityStore = {
  getState(entityId: string): Promise<EntityState | null>;
  upsertState(
    entityId: string,
    patch: Partial<EntityState>,
  ): Promise<void>;

  insertTick(tick: InsertTick): Promise<string>;
  updateTick(tickId: string, patch: TickPatch): Promise<void>;
  getLatestTick(entityId: string): Promise<TickRecord | null>;
  getPreviousTickStartedAt(
    entityId: string,
    currentTickNumber: number,
  ): Promise<Date | null>;

  listGoals(
    entityId: string,
    filter?: { status?: GoalStatus[] },
  ): Promise<GoalRecord[]>;
  getGoal(goalId: string): Promise<GoalRecord | null>;
  applyGoalMutations(
    tickId: string,
    mutations: GoalMutation[],
  ): Promise<void>;
  insertGoalTick(entry: InsertGoalTick): Promise<string>;
  updateGoalTick(
    goalTickId: string,
    patch: { acted: boolean; summary: string },
  ): Promise<void>;

  insertAttempt(attempt: InsertAttempt): Promise<InsertAttemptResult>;
  markAttemptCompleted(
    attemptId: string,
    overrides?: Record<string, unknown>,
  ): Promise<void>;
  markAttemptFailed(attemptId: string, error: string): Promise<void>;
  listAttempts(tickId: string): Promise<ActionAttempt[]>;
  getRecentAttempts(
    entityId: string,
    opts: { tickWindow: number },
  ): Promise<ActionAttempt[]>;

  listSchedulableEntities(): Promise<EntityState[]>;

  migrate(): Promise<void>;
};

// --- Scheduler ---

export type SchedulerAdapter = {
  enqueue(opts: {
    entityId: string;
    delayMs: number;
    jobId: string;
  }): Promise<void>;

  remove(jobId: string): Promise<void>;

  reschedule(opts: { jobId: string; delayMs: number }): Promise<void>;
};

// --- Config ---

export type CadenceConfig = {
  min: number;
  max: number;
  default: number;
};

export type GovernanceCaps = {
  perPass: number;
  perTick: number;
};

export type SoftCap = {
  name: string;
  evaluate: (ctx: {
    actionType: string;
    target: Record<string, unknown>;
    recentAttempts: ActionAttempt[];
  }) => { triggered: boolean; warning?: string };
};

export type SchedulerConfig = {
  adapter: SchedulerAdapter;
  store: ProactivityStore;
  cadence: CadenceConfig;
  identity: (entityId: string) => string;
  onTick: (entityId: string, trigger: TickTrigger) => Promise<TickResult>;
};

export type GovernanceConfig = {
  store: ProactivityStore;
  caps: GovernanceCaps;
  softCaps?: SoftCap[];
  dryRun?: boolean;
};

export type HeartbeatConfig = {
  store: ProactivityStore;
  sources?: BriefingSource[];
  governance: GovernanceConfig;
  cadence: CadenceConfig;
  tick: (ctx: TickContext) => Promise<TickCallbackResult>;
  entityCreatedAt?: (entityId: string) => Promise<Date>;
};

export type PlanActConfig = HeartbeatConfig & {
  planner: (ctx: PlannerContext) => Promise<PlanOutput>;
  executor: (ctx: ExecutorContext) => Promise<PassResult>;
};

export type TickContext = {
  boundary: BriefingBoundary;
  briefing: Record<string, unknown>;
  goals: GoalRecord[];
  governance: GovernanceHandle;
};

export type PlannerContext = {
  boundary: BriefingBoundary;
  briefing: Record<string, unknown>;
  goals: GoalRecord[];
};

export type ExecutorContext = {
  goal: GoalRecord;
  boundary: BriefingBoundary;
  briefing: Record<string, unknown>;
  governance: GovernanceHandle;
};

export type GovernanceHandle = {
  dispatch: (request: DispatchRequest) => Promise<DispatchResult>;
};

export type TickCallbackResult = {
  cadenceHint?: CadenceHint;
};
