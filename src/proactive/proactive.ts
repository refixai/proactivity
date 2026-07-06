// proactive() — the default door into the SDK.
//
// Wraps an UNCHANGED agent (via a framework adapter) in the full proactive
// loop, compiled down to the primitives: createHeartbeat + createScheduler +
// the governance envelope + a store. Every wake runs the four moments from
// docs/implementation-philosophy.md:
//
//   INJECT    render the situation report from the store
//   RUN       adapter.run(...) inside the tick scope (governed() tools attach here)
//   REFLECT   the dev's model turns the transcript into ledger + goals + cadence
//   SCHEDULE  the scheduler re-arms at the reflected cadence
//
// Ejecting to the primitives is not a migration: this file is proof they
// compose — same store, same ledger, same scheduler underneath.

import { createHeartbeat } from "../core/heartbeat.js";
import { createScheduler } from "../core/scheduler.js";
import type {
  CadenceConfig,
  GovernanceCaps,
  ProactivityStore,
  TickTrigger,
} from "../core/types.js";
import { createTestStore } from "../memory/index.js";
import { createTimerAdapter } from "../timer/index.js";
import { parseDuration } from "./duration.js";
import { addGoal, completeGoal } from "./goalsApi.js";
import { consoleNarrator } from "./observe.js";
import { runReflection } from "./reflect.js";
import { loadLedger, renderReport } from "./report.js";
import { ensureSeededGoals, normalizeGoalSeeds, pickPrimaryGoal, pinnedGoalIds } from "./seeds.js";
import { runInTickScope } from "./tickScope.js";
import type {
  ProactiveAgentAdapter,
  ProactiveConfig,
  ProactiveEvent,
  ProactiveHandle,
  Transcript,
  WakeContext,
} from "./types.js";

const DEFAULT_RECENT_WAKES = 5;
const DEFAULT_MAX_ACTIONS_PER_WAKE = 10;

export const proactive = <TCustom = unknown>(
  adapter: ProactiveAgentAdapter<TCustom>,
  config: ProactiveConfig<TCustom>,
): ProactiveHandle => {
  if (!config?.reflection?.model || typeof config.reflection.model.generate !== "function") {
    throw new Error(
      "proactive() requires `reflection.model` — your own LLM behind the ReasoningModel interface " +
        "(e.g. anthropicModel(client, ...) from @refix/proactivity/anthropic, " +
        "or langchainModel(chatModel) from @refix/proactivity/langgraph). It powers reflection.",
    );
  }

  // Observability: console narration by default, custom fn, or false. An
  // observer is telemetry — if it throws, the wake must not care.
  const observer = config.observe === false ? null : (config.observe ?? consoleNarrator());
  const emit = (event: ProactiveEvent): void => {
    if (!observer) return;
    try {
      observer(event);
    } catch {
      // never let narration break the loop
    }
  };

  const store: ProactivityStore = config.store ?? createTestStore();
  const cadence: CadenceConfig = (() => {
    const min = parseDuration(config.cadence?.min ?? "15m", "cadence.min");
    const max = parseDuration(config.cadence?.max ?? "24h", "cadence.max");
    const def = parseDuration(config.cadence?.default ?? min, "cadence.default");
    if (min > max) throw new Error(`cadence.min (${min}ms) exceeds cadence.max (${max}ms)`);
    return { min, max, default: Math.min(Math.max(def, min), max) };
  })();

  const perWake = config.governance?.maxActionsPerWake ?? DEFAULT_MAX_ACTIONS_PER_WAKE;
  // One goal-tick per wake, so the per-pass and per-tick ceilings coincide.
  const caps: GovernanceCaps = { perPass: perWake, perTick: perWake };

  const seeds = normalizeGoalSeeds(config.goals);
  const recentWakes = config.report?.recentWakes ?? DEFAULT_RECENT_WAKES;

  // The heartbeat callback doesn't receive the trigger (it's a tick-row
  // concern), but the report wants to tell the agent "you were woken
  // manually". The scheduler's onTick is our own call site, so stash it there.
  const lastTrigger = new Map<string, TickTrigger>();

  const heartbeat = createHeartbeat({
    store,
    cadence,
    governance: { store, caps },
    tick: async ({ goals, governance, boundary }) => {
      // --- Wake gate: the only pre-model code, cost control only ---
      if (config.shouldWake) {
        const due = await config.shouldWake({
          entityId: boundary.entityId,
          now: boundary.startedAt,
          lastWakeAt: boundary.previousTickStartedAt,
          goals,
        });
        if (!due) {
          emit({
            type: "wake_skipped",
            entityId: boundary.entityId,
            reason: "shouldWake declined — the model was not woken",
          });
          return {
            cadenceHint: {
              nextTickMs: cadence.default,
              reasoning: "shouldWake declined — the model was not woken",
            },
          };
        }
      }

      // --- Ensure declared goals exist (idempotent on stable ids) ---
      goals = await ensureSeededGoals(store, boundary.entityId, seeds);

      // Every declared goal can be completed externally (handle.completeGoal);
      // seeding won't resurrect a terminal goal, so an empty portfolio is a
      // reachable state, not a bug — skip the wake instead of crashing it.
      if (goals.length === 0) {
        const reason =
          "no active goals — add one with handle.addGoal() or declare goals in config";
        emit({ type: "wake_skipped", entityId: boundary.entityId, reason });
        return { cadenceHint: { nextTickMs: cadence.default, reasoning: reason } };
      }

      // --- Primary goal: where this wake's governed actions attribute ---
      const primary = pickPrimaryGoal(goals);
      if (!primary) {
        // Unreachable by construction (seeds guarantee at least one goal), but
        // fail loudly rather than dispatch actions attributed to nothing.
        throw new Error("proactive(): no goal available to attribute the wake to");
      }
      const goalTickId = await store.insertGoalTick({
        goalId: primary.id,
        tickId: boundary.tickId,
        orderIndex: 0,
      });

      // --- INJECT: the situation report ---
      const ledger = await loadLedger(store, boundary.entityId, boundary.tickId, recentWakes);
      const contextBase: Omit<WakeContext, "report"> = {
        entityId: boundary.entityId,
        tickId: boundary.tickId,
        tickNumber: boundary.tickNumber,
        trigger: lastTrigger.get(boundary.entityId) ?? "scheduled",
        now: boundary.startedAt,
        lastWakeAt: boundary.previousTickStartedAt,
        goals,
        ledger,
      };
      const report = renderReport(contextBase);
      const context: WakeContext = { ...contextBase, report };

      emit({
        type: "wake_started",
        entityId: boundary.entityId,
        tickNumber: boundary.tickNumber,
        trigger: contextBase.trigger,
        goalCount: goals.length,
        lastWakeAt: boundary.previousTickStartedAt,
      });

      // --- RUN: the unchanged agent, inside the tick scope ---
      // An agent crash fails the wake honestly (the heartbeat records the
      // failed tick); governed actions dispatched before the crash are real
      // and already audited — that's the point of claiming keys up front.
      const transcript: Transcript = await runInTickScope(
        {
          entityId: boundary.entityId,
          tickId: boundary.tickId,
          goalId: primary.id,
          goalTickId,
          governance,
          observe: emit,
        },
        () =>
          adapter.run({
            context,
            message: report,
            observe: (event) => emit({ type: "agent_event", entityId: boundary.entityId, event }),
            ...(config.agentInput ? { custom: config.agentInput(context) } : {}),
          }),
      );

      // --- REFLECT: bookkeeping + pacing on the dev's model ---
      const reflection = await runReflection({
        model: config.reflection.model,
        promptContext: {
          context,
          transcript,
          goals,
          // Derived from the live portfolio, so runtime-added pinned goals
          // (handle.addGoal) are shielded exactly like config-declared ones.
          pinnedGoalIds: pinnedGoalIds(goals),
          cadence: { minMs: cadence.min, maxMs: cadence.max },
          instructions: config.reflection.instructions ?? {},
        },
        promptOverride: config.reflection.prompt,
      });

      emit({
        type: "reflection",
        entityId: boundary.entityId,
        ledgerEntry: reflection.ledgerEntry,
        goalMutations: reflection.goalMutations,
        nextWakeMinutes: reflection.nextWakeMinutes,
        nextWakeReasoning: reflection.nextWakeReasoning,
        warnings: reflection.warnings,
      });

      if (reflection.goalMutations.length > 0) {
        await store.applyGoalMutations(boundary.entityId, reflection.goalMutations);
      }

      // The wake's ledger entry. `acted` derives from the audit trail, not
      // from anything the model claims — the ledger cannot be misreported.
      const attempts = await store.listAttempts(boundary.tickId);
      const acted = attempts.some(
        (a) => a.governanceOutcome === "taken" || a.governanceOutcome === "soft_cap_overridden",
      );
      const summary =
        reflection.warnings.length > 0
          ? `${reflection.ledgerEntry}\n[reflection warnings: ${reflection.warnings.join("; ")}]`
          : reflection.ledgerEntry;
      await store.updateGoalTick(goalTickId, { acted, summary });

      const nextTickMs = Math.round(reflection.nextWakeMinutes * 60_000);
      emit({
        type: "wake_completed",
        entityId: boundary.entityId,
        tickNumber: boundary.tickNumber,
        acted,
        nextWakeMs: nextTickMs,
      });

      return {
        cadenceHint: {
          nextTickMs,
          reasoning: reflection.nextWakeReasoning,
        },
      };
    },
  });

  const scheduler = createScheduler({
    adapter: config.schedule ?? createTimerAdapter(),
    store,
    cadence,
    identity: (entityId) => `proactive:${entityId}`,
    onTick: async (entityId, trigger) => {
      lastTrigger.set(entityId, trigger);
      try {
        return await heartbeat.runTick(entityId, trigger);
      } catch (error) {
        // The heartbeat already recorded the failed tick; this is narration.
        emit({ type: "wake_failed", entityId, error });
        throw error;
      } finally {
        lastTrigger.delete(entityId);
      }
    },
    onError:
      config.onError ??
      ((error, entityId) => {
        console.error(`[proactive] scheduled wake failed for "${entityId}":`, error);
      }),
  });

  return {
    start: (entityId) => scheduler.start(entityId),
    stop: (entityId) => scheduler.stop(entityId),
    wake: (entityId) => scheduler.triggerNow(entityId),
    resume: () => scheduler.seedFromStore(),
    async addGoal(entityId, goal, opts) {
      const record = await addGoal(store, entityId, goal);
      if (opts?.wake) await scheduler.triggerNow(entityId);
      return record;
    },
    completeGoal: (entityId, goalId, reason) => completeGoal(store, entityId, goalId, reason),
    listGoals: (entityId, filter) => store.listGoals(entityId, filter),
    store,
  };
};
