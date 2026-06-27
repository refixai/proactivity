import type {
  ActionAttempt,
  EntityState,
  GoalMutation,
  GoalRecord,
  InsertAttempt,
  InsertAttemptResult,
  InsertGoalTick,
  InsertTick,
  ProactivityStore,
  TickPatch,
  TickRecord,
} from "../core/types.js";

export const createMemoryStore = (): ProactivityStore => {
  let counter = 0;
  const id = () => `mem_${++counter}`;
  const entities = new Map<string, EntityState>();
  const ticks = new Map<string, TickRecord>();
  const goals = new Map<string, GoalRecord>();
  const goalTicks = new Map<string, { goalId: string; tickId: string; orderIndex: number; acted: boolean; summary: string }>();
  const attempts = new Map<string, ActionAttempt>();
  const idempotencyIndex = new Map<string, string>();

  return {
    // --- Entity State ---

    async getState(entityId) {
      return entities.get(entityId) ?? null;
    },

    async upsertState(entityId, patch) {
      const existing = entities.get(entityId);
      if (existing) {
        entities.set(entityId, { ...existing, ...patch });
      } else {
        entities.set(entityId, {
          entityId,
          enabled: true,
          actionsRequireApproval: false,
          lastTickAt: null,
          nextScheduledTickAt: null,
          ...patch,
        });
      }
    },

    // --- Ticks ---

    async insertTick(tick: InsertTick) {
      const tickId = id();
      ticks.set(tickId, {
        id: tickId,
        entityId: tick.entityId,
        tickNumber: tick.tickNumber,
        trigger: tick.trigger,
        dryRun: tick.dryRun,
        status: "running",
        startedAt: new Date(),
        completedAt: null,
        goalsWorkedCount: 0,
        actionsTakenCount: 0,
        cadenceHintMs: null,
        error: null,
      });
      return tickId;
    },

    async updateTick(tickId, patch: TickPatch) {
      const tick = ticks.get(tickId);
      if (!tick) return;
      ticks.set(tickId, { ...tick, ...patch });
    },

    async getLatestTick(entityId) {
      let latest: TickRecord | null = null;
      for (const t of ticks.values()) {
        if (t.entityId === entityId && (!latest || t.tickNumber > latest.tickNumber)) {
          latest = t;
        }
      }
      return latest;
    },

    async getPreviousTickStartedAt(entityId, currentTickNumber) {
      let prev: TickRecord | null = null;
      for (const t of ticks.values()) {
        if (t.entityId === entityId && t.tickNumber < currentTickNumber) {
          if (!prev || t.tickNumber > prev.tickNumber) prev = t;
        }
      }
      return prev?.startedAt ?? null;
    },

    // --- Goals ---

    async listGoals(entityId, filter) {
      const result: GoalRecord[] = [];
      for (const g of goals.values()) {
        if (g.entityId !== entityId) continue;
        if (filter?.status && !filter.status.includes(g.status)) continue;
        result.push(g);
      }
      return result;
    },

    async getGoal(goalId) {
      return goals.get(goalId) ?? null;
    },

    async applyGoalMutations(tickId, mutations: GoalMutation[]) {
      const tick = ticks.get(tickId);
      const entityId = tick?.entityId ?? "unknown";
      const now = new Date();

      for (const m of mutations) {
        if (m.op === "create") {
          const goalId = m.goalId ?? id();
          goals.set(goalId, {
            id: goalId,
            entityId,
            title: m.title!,
            objective: m.objective ?? "",
            doneCondition: m.doneCondition ?? "",
            findings: m.findings ?? "",
            nextActions: m.nextActions ?? null,
            creationReasoning: m.reasoning,
            status: "active",
            priority: m.priority ?? "medium",
            lastWorkedAt: null,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          const goal = goals.get(m.goalId!);
          if (!goal) continue;

          const patch: Partial<GoalRecord> = { updatedAt: now };

          if (m.op === "update") {
            if (m.title !== undefined) patch.title = m.title;
            if (m.objective !== undefined) patch.objective = m.objective;
            if (m.doneCondition !== undefined) patch.doneCondition = m.doneCondition;
            if (m.findings !== undefined) patch.findings = m.findings;
            if (m.nextActions !== undefined) patch.nextActions = m.nextActions;
            if (m.priority !== undefined) patch.priority = m.priority;
          } else if (m.op === "reprioritize") {
            if (m.priority !== undefined) patch.priority = m.priority;
          } else if (m.op === "complete") {
            patch.status = "completed";
          } else if (m.op === "archive") {
            patch.status = "archived";
          } else if (m.op === "pause") {
            patch.status = "paused";
          }

          goals.set(m.goalId!, { ...goal, ...patch });
        }
      }
    },

    async insertGoalTick(entry: InsertGoalTick) {
      const gtId = id();
      goalTicks.set(gtId, { ...entry, acted: false, summary: "" });
      return gtId;
    },

    async updateGoalTick(goalTickId, patch) {
      const gt = goalTicks.get(goalTickId);
      if (!gt) return;
      goalTicks.set(goalTickId, { ...gt, ...patch });
    },

    // --- Attempts ---

    async insertAttempt(attempt: InsertAttempt): Promise<InsertAttemptResult> {
      const existing = idempotencyIndex.get(attempt.idempotencyKey);
      if (existing) {
        const prior = attempts.get(existing)!;
        return { kind: "idempotency_conflict", prior: { attemptId: prior.id, outcome: prior.governanceOutcome } };
      }

      const attemptId = id();
      const record: ActionAttempt = {
        id: attemptId,
        goalId: attempt.goalId,
        tickId: attempt.tickId,
        goalTickId: attempt.goalTickId,
        actionType: attempt.actionType,
        idempotencyKey: attempt.idempotencyKey,
        governanceOutcome: attempt.governanceOutcome,
        reasoning: attempt.reasoning,
        denialReason: attempt.denialReason,
        overrideReason: attempt.overrideReason,
        target: attempt.target,
        payload: attempt.payload,
        attemptedAt: new Date(),
        completedAt: null,
        error: null,
      };
      attempts.set(attemptId, record);
      idempotencyIndex.set(attempt.idempotencyKey, attemptId);
      return { kind: "inserted", attemptId };
    },

    async markAttemptCompleted(attemptId, overrides) {
      const a = attempts.get(attemptId);
      if (!a) return;
      attempts.set(attemptId, { ...a, completedAt: new Date(), ...overrides });
    },

    async markAttemptFailed(attemptId, error) {
      const a = attempts.get(attemptId);
      if (!a) return;
      attempts.set(attemptId, { ...a, error });
    },

    async listAttempts(tickId) {
      return [...attempts.values()].filter((a) => a.tickId === tickId);
    },

    async getRecentAttempts(entityId, opts) {
      const entityTicks = [...ticks.values()]
        .filter((t) => t.entityId === entityId)
        .sort((a, b) => b.tickNumber - a.tickNumber)
        .slice(0, opts.tickWindow);
      const tickIds = new Set(entityTicks.map((t) => t.id));
      return [...attempts.values()].filter((a) => tickIds.has(a.tickId));
    },

    async listSchedulableEntities() {
      return [...entities.values()].filter((e) => e.enabled && e.nextScheduledTickAt !== null);
    },

    async migrate() {},
  };
};
