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
  GoalRecord,
  GovernanceCaps,
  ProactivityStore,
  TickTrigger,
} from "../core/types.js";
import { createTestStore } from "../memory/index.js";
import { createTimerAdapter } from "../timer/index.js";
import { parseDuration } from "./duration.js";
import { runReflection } from "./reflect.js";
import { loadLedger, renderReport } from "./report.js";
import { runInTickScope } from "./tickScope.js";
import type {
  GoalSeed,
  ProactiveAgentAdapter,
  ProactiveConfig,
  ProactiveHandle,
  Transcript,
  WakeContext,
} from "./types.js";

const DEFAULT_LEDGER_WINDOW = 5;
const DEFAULT_CAPS_PER_WAKE = 10;

// When the developer declares no goals, the loop still needs a standing goal —
// governed actions attribute to it and its scratchpad becomes the agent's
// memory. Pinned so reflection can evolve it but never close it.
const FALLBACK_GOAL: Required<Omit<GoalSeed, "priority">> & { priority: "medium" } = {
  id: "proactive-loop",
  title: "Run the proactive loop",
  objective: "Wake on cadence, review the situation, and act when something genuinely warrants it.",
  doneCondition: "Standing goal — never done.",
  priority: "medium",
  pinned: true,
};

const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "goal";

const PRIORITY_RANK: Record<GoalRecord["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const proactive = <TCustom = unknown>(
  adapter: ProactiveAgentAdapter<TCustom>,
  config: ProactiveConfig<TCustom>,
): ProactiveHandle => {
  if (!config?.model || typeof config.model.generate !== "function") {
    throw new Error(
      "proactive() requires `model` — your own LLM behind the ReasoningModel interface " +
        "(e.g. anthropicModel(client, ...) from @refix/proactivity/anthropic, " +
        "or langchainModel(chatModel) from @refix/proactivity/langgraph). It powers reflection.",
    );
  }

  const store: ProactivityStore = config.store ?? createTestStore();
  const cadence: CadenceConfig = (() => {
    const min = parseDuration(config.cadence?.min ?? "15m", "cadence.min");
    const max = parseDuration(config.cadence?.max ?? "24h", "cadence.max");
    const def = parseDuration(config.cadence?.default ?? min, "cadence.default");
    if (min > max) throw new Error(`cadence.min (${min}ms) exceeds cadence.max (${max}ms)`);
    return { min, max, default: Math.min(Math.max(def, min), max) };
  })();

  const perWake = config.caps?.perWake ?? DEFAULT_CAPS_PER_WAKE;
  // One goal-tick per wake, so the per-pass and per-tick ceilings coincide.
  const caps: GovernanceCaps = { perPass: perWake, perTick: perWake };

  // Stable ids make seeding idempotent across restarts and across stores.
  const seeds = (config.goals?.length ? config.goals : [FALLBACK_GOAL]).map((seed) => ({
    ...seed,
    id: seed.id ?? slugify(seed.title),
  }));
  const pinnedGoalIds = seeds.filter((s) => s.pinned).map((s) => s.id);
  const ledgerWindow = config.ledgerWindow ?? DEFAULT_LEDGER_WINDOW;

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
      if (config.gate) {
        const due = await config.gate({
          entityId: boundary.entityId,
          now: boundary.startedAt,
          lastWakeAt: boundary.previousTickStartedAt,
          goals,
        });
        if (!due) {
          return {
            cadenceHint: {
              nextTickMs: cadence.default,
              reasoning: "wake gate declined — the model was not woken",
            },
          };
        }
      }

      // --- Ensure declared goals exist (idempotent on stable ids) ---
      const missing = [];
      for (const seed of seeds) {
        if (!(await store.getGoal(seed.id))) missing.push(seed);
      }
      if (missing.length > 0) {
        await store.applyGoalMutations(
          boundary.tickId,
          missing.map((seed) => ({
            op: "create" as const,
            goalId: seed.id,
            title: seed.title,
            objective: seed.objective,
            doneCondition: seed.doneCondition,
            priority: seed.priority,
            reasoning: "Declared in proactive() config",
          })),
        );
        goals = await store.listGoals(boundary.entityId, { status: ["active", "paused"] });
      }

      // --- Primary goal: where this wake's governed actions attribute ---
      const active = goals.filter((g) => g.status === "active");
      const primary = [...(active.length ? active : goals)].sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
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
      const ledger = await loadLedger(store, boundary.entityId, boundary.tickId, ledgerWindow);
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
        },
        () =>
          adapter.run({
            context,
            message: report,
            ...(config.input ? { custom: config.input(context) } : {}),
          }),
      );

      // --- REFLECT: bookkeeping + pacing on the dev's model ---
      const reflection = await runReflection({
        model: config.model,
        promptContext: {
          context,
          transcript,
          goals,
          pinnedGoalIds,
          cadence: { minMs: cadence.min, maxMs: cadence.max },
          instructions: config.instructions ?? {},
        },
        promptOverride: config.prompts?.reflect,
      });

      if (reflection.goalMutations.length > 0) {
        await store.applyGoalMutations(boundary.tickId, reflection.goalMutations);
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

      return {
        cadenceHint: {
          nextTickMs: Math.round(reflection.nextWakeMinutes * 60_000),
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
    store,
  };
};
