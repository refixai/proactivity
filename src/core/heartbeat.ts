import { assembleBriefing } from "./briefing.js";
import { clampCadence } from "./cadence.js";
import { createGovernance } from "./governance.js";
import { validateGoalMutations } from "./goals.js";
import { createLedger } from "./ledger.js";
import type {
  BriefingBoundary,
  GoalRecord,
  HeartbeatConfig,
  PlanActConfig,
  TickResult,
  TickTrigger,
} from "./types.js";

export type Heartbeat = {
  runTick: (entityId: string, trigger: TickTrigger) => Promise<TickResult>;
};

type TickSetup = {
  tickId: string;
  tickNumber: number;
  boundary: BriefingBoundary;
  briefing: Record<string, unknown>;
  goals: GoalRecord[];
};

const prepareTick = async (
  config: Omit<HeartbeatConfig, "tick">,
  entityId: string,
  trigger: TickTrigger,
): Promise<TickSetup> => {
  const { store, sources = [], governance: govConfig } = config;

  const { tickId, tickNumber, startedAt } = await store.insertTick({
    entityId,
    trigger,
    dryRun: govConfig.dryRun ?? false,
  });

  const previousTickStartedAt = await store.getPreviousTickStartedAt(entityId, tickNumber);
  const deltaCutoff = previousTickStartedAt
    ?? (config.entityCreatedAt ? await config.entityCreatedAt(entityId) : startedAt);

  const boundary: BriefingBoundary = {
    entityId,
    tickId,
    tickNumber,
    startedAt,
    previousTickStartedAt,
    deltaCutoff,
  };

  const briefing = await assembleBriefing(sources, boundary);
  const goals = await store.listGoals(entityId, { status: ["active", "paused"] });

  return { tickId, tickNumber, boundary, briefing, goals };
};

export const createHeartbeat = (config: HeartbeatConfig): Heartbeat => {
  const { store, governance: govConfig, cadence: cadenceConfig } = config;

  return {
    runTick: async (entityId, trigger) => {
      const { tickId, boundary, briefing, goals } = await prepareTick(config, entityId, trigger);
      const ledger = createLedger();
      const governance = createGovernance(govConfig, tickId, entityId, ledger);

      try {
        const callbackResult = await config.tick({ boundary, briefing, goals, governance });

        const cadenceHintMs = callbackResult.cadenceHint?.nextTickMs ?? null;
        const nextCadenceMs = clampCadence(cadenceHintMs, cadenceConfig);

        await store.updateTick(tickId, {
          status: "completed",
          completedAt: new Date(),
          actionsTakenCount: ledger.countActionsTaken(),
          cadenceHintMs,
        });

        await store.upsertState(entityId, {
          lastTickAt: new Date(),
          nextScheduledTickAt: new Date(Date.now() + nextCadenceMs),
        });

        return {
          tickId,
          status: "completed",
          goalsWorkedCount: 0,
          actionsTakenCount: ledger.countActionsTaken(),
          nextCadenceMs,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await store.updateTick(tickId, { status: "failed", completedAt: new Date(), error });

        return {
          tickId,
          status: "failed",
          goalsWorkedCount: 0,
          actionsTakenCount: ledger.countActionsTaken(),
          nextCadenceMs: cadenceConfig.default,
        };
      }
    },
  };
};

export const createPlanActHeartbeat = (config: PlanActConfig): Heartbeat => {
  const { store, governance: govConfig, cadence: cadenceConfig } = config;

  return {
    runTick: async (entityId, trigger) => {
      const { tickId, boundary, briefing, goals } = await prepareTick(config, entityId, trigger);

      try {
        const plan = await config.planner({ boundary, briefing, goals });

        if (plan.goalMutations.length > 0) {
          const mutationErrors = validateGoalMutations(plan.goalMutations);
          if (mutationErrors.length > 0) {
            throw new Error(`Invalid goal mutations from planner: ${mutationErrors.join("; ")}`);
          }
          await store.applyGoalMutations(tickId, plan.goalMutations);
        }

        const ledger = createLedger();
        let goalsWorkedCount = 0;

        for (const selected of plan.selectedGoals) {
          const goal = await store.getGoal(selected.goalId);
          // getGoal keys on id alone; reject a planner-supplied id from another entity.
          if (!goal || goal.entityId !== entityId) continue;

          const governance = createGovernance(govConfig, tickId, entityId, ledger);
          const goalTickId = await store.insertGoalTick({
            goalId: goal.id,
            tickId,
            orderIndex: goalsWorkedCount,
          });

          try {
            const passResult = await config.executor({ goal, goalTickId, boundary, briefing, governance });

            await store.updateGoalTick(goalTickId, {
              acted: passResult.acted,
              summary: passResult.summary,
            });

            if (passResult.acted) goalsWorkedCount++;
          } catch (err) {
            await store.updateGoalTick(goalTickId, {
              acted: false,
              summary: `Executor error: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }

        const cadenceHintMs = plan.cadenceHint?.nextTickMs ?? null;
        const nextCadenceMs = clampCadence(cadenceHintMs, cadenceConfig);

        await store.updateTick(tickId, {
          status: "completed",
          completedAt: new Date(),
          goalsWorkedCount,
          actionsTakenCount: ledger.countActionsTaken(),
          cadenceHintMs,
        });

        return {
          tickId,
          status: "completed",
          goalsWorkedCount,
          actionsTakenCount: ledger.countActionsTaken(),
          nextCadenceMs,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await store.updateTick(tickId, { status: "failed", completedAt: new Date(), error });

        return {
          tickId,
          status: "failed",
          goalsWorkedCount: 0,
          actionsTakenCount: 0,
          nextCadenceMs: cadenceConfig.default,
        };
      }
    },
  };
};
