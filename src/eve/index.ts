// Eve integration — proactivity for Eve agents, built with Eve's grain
// instead of against it.
//
// Eve is a durable-workflow runtime: agents are directories, tools and hooks
// are filesystem-discovered files, state serializes as plain JSON across step
// boundaries, and scheduling is a static cron. Four consequences shape this
// module (all proven against examples/eve):
//
//   1. No live handles survive a step boundary, so nothing here uses
//      AsyncLocalStorage — governance is REBUILT per tool call from the tick
//      ids in the developer's `defineState` slot, with its ledger re-warmed
//      from the store's attempt rows (which also makes per-wake caps hold
//      across Eve's serialization, something a fresh in-memory ledger can't).
//   2. The cron is static, so self-adjusting cadence runs ON TOP of it: the
//      cron is the polling floor, and a due-gate in the session hook decides
//      which firings are real wakes. Reflection programs the next due time.
//   3. Hooks can't inject messages, so the situation report is FETCHED by the
//      agent as its first tool call (get_briefing) — the schedule's markdown
//      prompt instructs it.
//   4. There is no transcript API, so reflection reads the agent's
//      self-report (a terminal finish_heartbeat tool, the same shape as a
//      plan-submission tool) enriched with the store's REAL audit rows — the
//      actions are ground truth even when the narrative is self-reported.
//      That fidelity limit is real and stated, not papered over.
//
// This module imports nothing from `eve` — factories return plain
// { description, inputSchema, execute } objects the developer hands to
// defineTool/defineHook in their own files (tool NAMES come from Eve
// filenames, so save them as tools/get_briefing.ts, tools/finish_heartbeat.ts).

import { z } from "zod";
import { clampCadence } from "../core/cadence.js";
import { createGovernance } from "../core/governance.js";
import { createLedger } from "../core/ledger.js";
import type {
  CadenceConfig,
  GoalRecord,
  GoalStatus,
  GovernanceCaps,
  ProactivityStore,
} from "../core/types.js";
import { addGoal, completeGoal } from "../proactive/goalsApi.js";
import { describeGovernanceOutcome } from "../proactive/governed.js";
import { parseDuration, type Duration } from "../proactive/duration.js";
import { runReflection } from "../proactive/reflect.js";
import { loadLedger, renderReport } from "../proactive/report.js";
import {
  ensureSeededGoals,
  normalizeGoalSeeds,
  pickPrimaryGoal,
  pinnedGoalIds,
} from "../proactive/seeds.js";
import type {
  GoalSeed,
  ProactiveConfig,
  ReasoningModel,
  TranscriptEvent,
} from "../proactive/types.js";

// --- The developer's defineState slot, structurally -----------------------------

// Matches an `eve/context` defineState slot without importing eve. The value
// must stay plain JSON — that constraint is Eve's, and it's why this type
// carries ids, never handles.
export type EveStateSlot<T> = {
  get(): T | null;
  update(updater: (previous: T | null) => T | null): void;
};

export type EveTickState = {
  due: boolean;
  tickId: string;
  tickNumber: number;
  goalId: string;
  goalTickId: string;
  startedAtIso: string;
  lastWakeAtIso: string | null;
};

// --- Config ---------------------------------------------------------------------

export type EveProactivityConfig = {
  store: ProactivityStore;
  // The SDK's own reasoning step — same shape as proactive()'s `reflection`
  // (model required; instructions/prompt optional).
  reflection: ProactiveConfig["reflection"];
  // Eve agents are one-entity processes; name the entity explicitly.
  entityId: string;
  // The defineState slot the developer declared:
  //   export const tickState = defineState<EveTickState | null>("proactivity.tick", () => null);
  state: EveStateSlot<EveTickState>;
  goals?: GoalSeed[];
  cadence?: { min?: Duration; max?: Duration; default?: Duration };
  governance?: ProactiveConfig["governance"];
  report?: ProactiveConfig["report"];
};

export type EveToolDefinition<TArgs = unknown> = {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(args: TArgs): Promise<unknown>;
};

export type EveGovernedToolInput<TArgs> = {
  description: string;
  // The developer's zod schema, passed through to defineTool untouched.
  inputSchema: z.ZodTypeAny;
  perform(args: TArgs): Promise<unknown> | unknown;
  // Audit/idempotency identity — defaults: filename-derived Eve tool name is
  // NOT visible here, so actionType defaults to "action"; set it.
  actionType?: string;
  target?: (args: TArgs) => Record<string, unknown>;
  reasoning?: (args: TArgs) => string;
};

export type EveProactivity = {
  // Hook body for events["session.started"] — opens the tick (or gates it).
  onSessionStarted(): Promise<void>;
  // Tool defs for the developer's tool files.
  briefingTool(): EveToolDefinition<Record<string, never>>;
  finishHeartbeatTool(): EveToolDefinition<{ report: string }>;
  governedTool<TArgs>(input: EveGovernedToolInput<TArgs>): EveToolDefinition<TArgs>;
  // Runtime goal management, same semantics as proactive()'s handle. Eve has
  // no in-process scheduler to poke, so `wakeNext` marks the entity due —
  // the NEXT cron firing becomes a real wake instead of a gated no-op.
  addGoal(goal: GoalSeed, opts?: { wakeNext?: boolean }): Promise<GoalRecord>;
  completeGoal(goalId: string, reason?: string): Promise<void>;
  listGoals(filter?: { status?: GoalStatus[] }): Promise<GoalRecord[]>;
  // The recommended markdown for the schedule file.
  scheduleMarkdown(extra?: string): string;
};

const DEFAULT_MAX_ACTIONS_PER_WAKE = 10;
const DEFAULT_RECENT_WAKES = 5;

export const createEveProactivity = (config: EveProactivityConfig): EveProactivity => {
  const { store, entityId, state } = config;
  const model = config.reflection.model;
  const cadence: CadenceConfig = (() => {
    const min = parseDuration(config.cadence?.min ?? "15m", "cadence.min");
    const max = parseDuration(config.cadence?.max ?? "24h", "cadence.max");
    const def = parseDuration(config.cadence?.default ?? min, "cadence.default");
    if (min > max) throw new Error(`cadence.min (${min}ms) exceeds cadence.max (${max}ms)`);
    return { min, max, default: Math.min(Math.max(def, min), max) };
  })();
  const perWake = config.governance?.maxActionsPerWake ?? DEFAULT_MAX_ACTIONS_PER_WAKE;
  const caps: GovernanceCaps = { perPass: perWake, perTick: perWake };
  const seeds = normalizeGoalSeeds(config.goals);
  const recentWakes = config.report?.recentWakes ?? DEFAULT_RECENT_WAKES;

  // Rebuild the governance envelope from serialized ids + the shared store.
  // The ledger is re-warmed from the store's attempt rows so per-wake caps
  // bind across Eve's step boundaries exactly as they would in-process.
  const rebuildGovernance = async (tick: EveTickState) => {
    const ledger = createLedger();
    for (const attempt of await store.listAttempts(tick.tickId)) {
      ledger.record({
        goalId: attempt.goalId,
        goalTickId: attempt.goalTickId,
        actionType: attempt.actionType,
        outcome: attempt.governanceOutcome,
      });
    }
    return createGovernance({ store, caps }, tick.tickId, entityId, ledger);
  };

  return {
    async onSessionStarted() {
      const now = new Date();

      // A previous session that died without finish_heartbeat leaves a
      // running tick — close it as failed so the ledger stays truthful.
      const latest = await store.getLatestTick(entityId);
      if (latest?.status === "running") {
        await store.updateTick(latest.id, {
          status: "failed",
          completedAt: now,
          error: "session ended without finish_heartbeat",
        });
      }

      // The due-gate: Eve's cron fires on a fixed interval (the polling
      // floor); the store decides which firings are real wakes. A not-due
      // firing seeds due:false and records nothing — a 5-minute cron must not
      // spam the ledger with no-op ticks.
      const entityState = await store.getState(entityId);
      if (entityState?.nextScheduledTickAt && now < entityState.nextScheduledTickAt) {
        state.update(() => ({
          due: false,
          tickId: "",
          tickNumber: 0,
          goalId: "",
          goalTickId: "",
          startedAtIso: now.toISOString(),
          lastWakeAtIso: entityState.lastTickAt?.toISOString() ?? null,
        }));
        return;
      }

      // A real wake: open the tick, seed goals, open the primary goal-tick,
      // and stash the ids (plain JSON) for the tools to rebuild from.
      const { tickId, tickNumber, startedAt } = await store.insertTick({
        entityId,
        trigger: "scheduled",
        dryRun: false,
      });
      const goals = await ensureSeededGoals(store, entityId, seeds);

      // All goals completed externally (addGoal/completeGoal are dev-facing) —
      // a reachable state, not a bug. Close the tick quietly and stay gated.
      if (goals.length === 0) {
        const reason = "no active goals — add one with addGoal() or declare goals in config";
        await store.updateTick(tickId, {
          status: "completed",
          completedAt: new Date(),
          cadenceReasoning: reason,
        });
        await store.upsertState(entityId, {
          lastTickAt: now,
          nextScheduledTickAt: new Date(now.getTime() + cadence.default),
        });
        state.update(() => ({
          due: false,
          tickId: "",
          tickNumber: 0,
          goalId: "",
          goalTickId: "",
          startedAtIso: now.toISOString(),
          lastWakeAtIso: null,
        }));
        return;
      }

      const primary = pickPrimaryGoal(goals);
      if (!primary) throw new Error("eve proactivity: no goal available to attribute the wake to");
      const goalTickId = await store.insertGoalTick({
        goalId: primary.id,
        tickId,
        orderIndex: 0,
      });
      const lastWakeAt = await store.getPreviousTickStartedAt(entityId, tickNumber);

      state.update(() => ({
        due: true,
        tickId,
        tickNumber,
        goalId: primary.id,
        goalTickId,
        startedAtIso: startedAt.toISOString(),
        lastWakeAtIso: lastWakeAt?.toISOString() ?? null,
      }));
    },

    briefingTool() {
      return {
        description:
          "Fetch this wake's situation report: your standing goals and their scratchpads, " +
          "recent wakes, and actions already taken. Call this FIRST every session. If it " +
          "returns due=false, this firing is not a real wake — do nothing and stop.",
        inputSchema: z.object({}),
        async execute() {
          const tick = state.get();
          if (!tick || !tick.due) {
            return {
              due: false,
              briefing:
                "Not a due wake (the next wake time hasn't arrived). Do nothing and stop.",
            };
          }
          const goals = await store.listGoals(entityId, { status: ["active", "paused"] });
          const ledger = await loadLedger(store, entityId, tick.tickId, recentWakes);
          const briefing = renderReport({
            entityId,
            tickId: tick.tickId,
            tickNumber: tick.tickNumber,
            trigger: "scheduled",
            now: new Date(tick.startedAtIso),
            lastWakeAt: tick.lastWakeAtIso ? new Date(tick.lastWakeAtIso) : null,
            goals,
            ledger,
          });
          return { due: true, briefing };
        },
      };
    },

    governedTool<TArgs>(input: EveGovernedToolInput<TArgs>) {
      return {
        description: input.description,
        inputSchema: input.inputSchema,
        async execute(args: TArgs) {
          const tick = state.get();
          if (!tick || !tick.due) {
            return {
              governanceOutcome: "hard_denied",
              note: "Not inside a due wake — no actions may be taken this session.",
            };
          }

          const governance = await rebuildGovernance(tick);
          let result: unknown;
          const dispatch = await governance.dispatch({
            goalId: tick.goalId,
            goalTickId: tick.goalTickId,
            actionType: input.actionType ?? "action",
            target: input.target
              ? input.target(args)
              : ((args ?? {}) as Record<string, unknown>),
            reasoning: input.reasoning?.(args) ?? `Agent called ${input.actionType ?? "action"}`,
            perform: async () => {
              result = await input.perform(args);
            },
          });

          const ran =
            dispatch.governanceOutcome === "taken" ||
            dispatch.governanceOutcome === "soft_cap_overridden";
          return {
            governanceOutcome: dispatch.governanceOutcome,
            ...(ran ? { result } : { note: describeGovernanceOutcome(dispatch.governanceOutcome, dispatch.denialReason) }),
          };
        },
      };
    },

    finishHeartbeatTool() {
      return {
        description:
          "Close this wake. Call this EXACTLY ONCE, as your LAST step, with a complete " +
          "report of what you observed, what you did (and deliberately didn't do), and " +
          "anything in flight — include identifiers. This runs reflection and schedules " +
          "the next wake.",
        inputSchema: z.object({
          report: z
            .string()
            .describe("Everything you observed and did this wake, concretely."),
        }),
        async execute({ report }: { report: string }) {
          const tick = state.get();
          if (!tick) return { closed: false, note: "No tick state — was session.started hooked?" };
          if (!tick.due) return { closed: false, note: "Not a due wake; nothing to close." };

          const now = new Date();
          const goals = await store.listGoals(entityId, { status: ["active", "paused"] });
          const attempts = await store.listAttempts(tick.tickId);

          // Transcript = the agent's self-report plus the REAL audit rows.
          // Eve exposes no session transcript; the narrative is self-reported
          // but the actions are ground truth from the store.
          const events: TranscriptEvent[] = [
            ...attempts.map(
              (a): TranscriptEvent => ({
                type: "tool_call",
                name: a.actionType,
                args: a.target,
                result: `governance: ${a.governanceOutcome}${a.denialReason ? ` (${a.denialReason})` : ""}`,
              }),
            ),
            { type: "model", content: report },
          ];

          const reflection = await runReflection({
            model,
            store,
            runOverride: config.reflection.run,
            promptContext: {
              context: {
                entityId,
                tickId: tick.tickId,
                tickNumber: tick.tickNumber,
                trigger: "scheduled",
                now,
                lastWakeAt: tick.lastWakeAtIso ? new Date(tick.lastWakeAtIso) : null,
                goals,
                ledger: [],
                report: "",
              },
              transcript: { events, finalOutput: report },
              goals,
              pinnedGoalIds: pinnedGoalIds(goals),
              cadence: { minMs: cadence.min, maxMs: cadence.max },
              instructions: config.reflection.instructions ?? {},
            },
            promptOverride: config.reflection.prompt,
          });

          if (reflection.goalMutations.length > 0) {
            await store.applyGoalMutations(entityId, reflection.goalMutations);
          }

          const acted = attempts.some(
            (a) => a.governanceOutcome === "taken" || a.governanceOutcome === "soft_cap_overridden",
          );
          const summary =
            reflection.warnings.length > 0
              ? `${reflection.ledgerEntry}\n[reflection warnings: ${reflection.warnings.join("; ")}]`
              : reflection.ledgerEntry;
          await store.updateGoalTick(tick.goalTickId, { acted, summary });

          const nextMs = clampCadence(Math.round(reflection.nextWakeMinutes * 60_000), cadence);
          await store.updateTick(tick.tickId, {
            status: "completed",
            completedAt: now,
            goalsWorkedCount: 1,
            actionsTakenCount: attempts.filter((a) => a.governanceOutcome === "taken").length,
            cadenceHintMs: nextMs,
            cadenceReasoning: reflection.nextWakeReasoning,
          });
          // The due-gate reads this: the next cron firing before this instant
          // is a no-op; the first one after it is the next real wake.
          await store.upsertState(entityId, {
            lastTickAt: now,
            nextScheduledTickAt: new Date(now.getTime() + nextMs),
          });

          state.update(() => null);
          return {
            closed: true,
            nextWakeInMinutes: Math.round(nextMs / 60_000),
            nextWakeReasoning: reflection.nextWakeReasoning,
          };
        },
      };
    },

    async addGoal(goal, opts) {
      const record = await addGoal(store, entityId, goal);
      if (opts?.wakeNext) {
        // Mark the entity due: the next cron firing passes the due-gate.
        await store.upsertState(entityId, { nextScheduledTickAt: new Date() });
      }
      return record;
    },

    completeGoal: (goalId, reason) => completeGoal(store, entityId, goalId, reason),

    listGoals: (filter) => store.listGoals(entityId, filter),

    scheduleMarkdown(extra?: string) {
      return [
        "A proactive wake has fired.",
        "FIRST call get_briefing. If it returns due=false, do nothing and stop.",
        "Otherwise: review the briefing, investigate with your tools, and take any",
        "genuinely warranted actions through your action tools — acting is optional,",
        "and never repeat an action the briefing already shows as taken.",
        "FINALLY call finish_heartbeat exactly once with a complete, concrete report",
        "of what you observed, what you did, what you deliberately didn't do, and",
        "anything you're waiting on (include identifiers).",
        ...(extra ? [extra] : []),
      ].join(" ");
    },
  };
};
