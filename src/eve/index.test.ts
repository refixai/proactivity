import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestStore } from "../memory/index.js";
import type { ReasoningModel } from "../proactive/types.js";
import { createEveProactivity, type EveStateSlot, type EveTickState } from "./index.js";

// --- Test doubles -------------------------------------------------------------

// A defineState slot without eve: plain JSON in, plain JSON out — the same
// contract Eve enforces by serialization.
const makeSlot = (): EveStateSlot<EveTickState> & { readonly value: EveTickState | null } => {
  let value: EveTickState | null = null;
  return {
    get value() {
      return value;
    },
    get: () => value,
    update: (updater) => {
      value = updater(value);
    },
  };
};

const makeReflectionModel = (
  overrides: Record<string, unknown> = {},
): { model: ReasoningModel; prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    model: {
      async generate(prompt) {
        prompts.push(prompt);
        return {
          ledgerEntry: "nudged t1; nothing else pending",
          goalMutations: [],
          nextWakeMinutes: 30,
          nextWakeReasoning: "waiting on a reply",
          ...overrides,
        };
      },
    },
  };
};

const setup = (opts: { perWake?: number } = {}) => {
  const store = createTestStore();
  const state = makeSlot();
  const { model, prompts } = makeReflectionModel();
  const nudged: string[] = [];

  const eve = createEveProactivity({
    store,
    reflection: { model },
    entityId: "eve-e1",
    state,
    goals: [{ id: "watch", title: "Watch replies", objective: "o", doneCondition: "d", pinned: true }],
    cadence: { min: "15m", max: "24h" },
    ...(opts.perWake !== undefined ? { governance: { maxActionsPerWake: opts.perWake } } : {}),
  });

  const sendNudge = eve.governedTool<{ threadId: string }>({
    description: "Nudge a thread",
    inputSchema: z.object({ threadId: z.string() }),
    actionType: "send_nudge",
    target: ({ threadId }) => ({ threadId }),
    perform: ({ threadId }) => {
      nudged.push(threadId);
      return "nudged";
    },
  });

  return { store, state, eve, sendNudge, nudged, prompts };
};

// --- The full eve-native wake lifecycle -----------------------------------------

describe("createEveProactivity", () => {
  test("full wake: hook opens tick, briefing renders, governed dedupe holds, finish reflects and schedules", async () => {
    const { store, state, eve, sendNudge, nudged, prompts } = setup();

    // session.started → a due wake (no schedule state yet).
    await eve.onSessionStarted();
    expect(state.value?.due).toBe(true);
    expect(state.value?.tickNumber).toBe(1);

    // The agent fetches its briefing as a tool call.
    const briefing = (await eve.briefingTool().execute({})) as { due: boolean; briefing: string };
    expect(briefing.due).toBe(true);
    expect(briefing.briefing).toContain("Situation report");
    expect(briefing.briefing).toContain("Watch replies");

    // Governed action: once taken, the duplicate is denied — across what in
    // real Eve would be separate serialized steps (the envelope is rebuilt
    // from ids + store on every call).
    const first = (await sendNudge.execute({ threadId: "t1" })) as Record<string, unknown>;
    expect(first.governanceOutcome).toBe("taken");
    expect(first.result).toBe("nudged");

    const duplicate = (await sendNudge.execute({ threadId: "t1" })) as Record<string, unknown>;
    expect(duplicate.governanceOutcome).toBe("hard_denied");
    expect(String(duplicate.note)).toContain("Do not retry");
    expect(nudged).toEqual(["t1"]);

    // finish_heartbeat closes the wake: reflection, ledger entry, next due time.
    const closed = (await eve
      .finishHeartbeatTool()
      .execute({ report: "nudged t1 about the stale thread; nothing else needed" })) as Record<
      string,
      unknown
    >;
    expect(closed.closed).toBe(true);
    expect(closed.nextWakeInMinutes).toBe(30);

    // Reflection saw the self-report AND the ground-truth audit rows. (The
    // duplicate suppression writes no attempt row — the prior row owns the
    // idempotency key — so it reaches reflection only via the self-report;
    // the agent itself was told in-band, asserted above.)
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("nudged t1 about the stale thread");
    expect(prompts[0]).toContain("governance: taken");

    // The tick row and ledger entry are complete; the state slot is cleared.
    const tick = (await store.getLatestTick("eve-e1"))!;
    expect(tick.status).toBe("completed");
    expect(tick.actionsTakenCount).toBe(1);
    expect(tick.cadenceHintMs).toBe(30 * 60_000);
    const goalTicks = await store.listGoalTicks(tick.id);
    expect(goalTicks[0]!.summary).toContain("nudged t1; nothing else pending");
    expect(goalTicks[0]!.acted).toBe(true);
    expect(state.value).toBeNull();

    // The due-gate is armed for the future.
    const entityState = (await store.getState("eve-e1"))!;
    expect(entityState.nextScheduledTickAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("a cron firing before the next due time is a no-op wake: nothing recorded, tools decline", async () => {
    const { store, state, eve, sendNudge } = setup();

    // Complete one full wake so nextScheduledTickAt is in the future.
    await eve.onSessionStarted();
    await eve.finishHeartbeatTool().execute({ report: "quiet" });

    // The cron fires again immediately — not due.
    await eve.onSessionStarted();
    expect(state.value?.due).toBe(false);

    const briefing = (await eve.briefingTool().execute({})) as { due: boolean };
    expect(briefing.due).toBe(false);

    const attempt = (await sendNudge.execute({ threadId: "t9" })) as Record<string, unknown>;
    expect(attempt.governanceOutcome).toBe("hard_denied");

    const finish = (await eve.finishHeartbeatTool().execute({ report: "n/a" })) as Record<
      string,
      unknown
    >;
    expect(finish.closed).toBe(false);

    // Exactly ONE tick exists — the real wake. The no-op firing left no rows.
    expect(await store.listRecentTicks("eve-e1", { limit: 10 })).toHaveLength(1);
  });

  test("a session that died without finish_heartbeat is closed as failed by the next wake", async () => {
    const { store, eve } = setup();

    await eve.onSessionStarted(); // wake #1 opens…
    // …and the session dies here: no finish_heartbeat.

    // Force the next firing to be due (no completed wake ever armed the gate).
    await eve.onSessionStarted();

    const ticks = await store.listRecentTicks("eve-e1", { limit: 10 });
    expect(ticks).toHaveLength(2);
    const stale = ticks.find((t) => t.tickNumber === 1)!;
    expect(stale.status).toBe("failed");
    expect(stale.error).toContain("without finish_heartbeat");
    expect(ticks.find((t) => t.tickNumber === 2)!.status).toBe("running");
  });

  test("per-wake caps hold across rebuilds because the ledger is re-warmed from the store", async () => {
    const { eve, sendNudge, nudged } = setup({ perWake: 1 });
    await eve.onSessionStarted();

    const first = (await sendNudge.execute({ threadId: "t1" })) as Record<string, unknown>;
    expect(first.governanceOutcome).toBe("taken");

    // Different target, so idempotency can't catch it — only the cap can, and
    // the cap only holds if the rebuilt ledger counts the prior attempt.
    const second = (await sendNudge.execute({ threadId: "t2" })) as Record<string, unknown>;
    expect(second.governanceOutcome).toBe("hard_denied");
    expect(String(second.note)).toContain("cap");
    expect(nudged).toEqual(["t1"]);
  });

  test("addGoal/completeGoal work outside sessions; wakeNext marks the entity due", async () => {
    const { store, eve } = setup();

    const goal = await eve.addGoal(
      { title: "Watch thread t9", objective: "o", doneCondition: "d", pinned: true },
      { wakeNext: true },
    );
    expect(goal.id).toBe("watch-thread-t9");
    expect(goal.pinned).toBe(true);
    expect((await eve.listGoals()).map((g) => g.id)).toContain("watch-thread-t9");

    // wakeNext: the due-gate lets the next cron firing through.
    const state = (await store.getState("eve-e1"))!;
    expect(state.nextScheduledTickAt!.getTime()).toBeLessThanOrEqual(Date.now());

    await eve.completeGoal("watch-thread-t9", "resolved");
    await expect(eve.completeGoal("watch-thread-t9")).rejects.toThrow(/already completed/);
  });

  test("scheduleMarkdown names the tool files and the terminal step", () => {
    const { eve } = setup();
    const markdown = eve.scheduleMarkdown("Focus on unanswered DMs.");
    expect(markdown).toContain("get_briefing");
    expect(markdown).toContain("finish_heartbeat");
    expect(markdown).toContain("Focus on unanswered DMs.");
  });
});
