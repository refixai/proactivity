import { describe, test, expect, vi, afterEach } from "vitest";
import { createTestStore } from "./memory/index.js";
import { createHeartbeat, createPlanActHeartbeat } from "./core/heartbeat.js";
import { createScheduler } from "./core/scheduler.js";
import { createTimerAdapter } from "./timer/index.js";
import type { TickContext, ExecutorContext, DispatchResult } from "./core/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E2E: single-loop heartbeat with scheduler", () => {
  test("multi-tick lifecycle: create goal → act → complete goal → cadence adjusts", async () => {
    const store = createTestStore();
    await store.upsertState("tenant-1", { enabled: true });

    const sideEffects: string[] = [];
    let tickCount = 0;

    const heartbeat = createHeartbeat({
      store,
      sources: [
        {
          name: "crm",
          load: async (boundary) => {
            if (boundary.tickNumber === 1) return { newLead: { name: "Alice", score: 85 } };
            if (boundary.tickNumber === 2) return { leadUpdate: { name: "Alice", replied: true } };
            return {};
          },
        },
      ],
      governance: { store, caps: { perPass: 3, perTick: 5 } },
      cadence: { min: 60_000, max: 86_400_000, default: 3_600_000 },
      tick: async (ctx: TickContext) => {
        tickCount++;

        if (ctx.boundary.tickNumber === 1) {
          // Tick 1: spot a lead, create a goal, send intro message
          await store.applyGoalMutations(ctx.boundary.tickId, [
            {
              op: "create",
              goalId: "goal-alice",
              title: "Engage Alice",
              objective: "Send intro and follow up",
              doneCondition: "Alice replies",
              findings: "High-score lead",
              reasoning: "New lead with score 85",
            },
          ]);

          const r = await ctx.governance.dispatch({
            goalId: "goal-alice",
            goalTickId: "gt-1",
            actionType: "send_message",
            target: { userId: "alice", channel: "email" },
            reasoning: "Introduce ourselves to high-score lead",
            perform: async () => { sideEffects.push("sent intro to Alice"); },
          });
          expect(r.governanceOutcome).toBe("taken");

          return { cadenceHint: { nextTickMs: 120_000, reasoning: "check for reply soon" } };
        }

        if (ctx.boundary.tickNumber === 2) {
          // Tick 2: Alice replied, complete the goal
          await store.applyGoalMutations(ctx.boundary.tickId, [
            { op: "complete", goalId: "goal-alice", reasoning: "Alice replied" },
          ]);

          return { cadenceHint: { nextTickMs: 86_400_000, reasoning: "nothing urgent" } };
        }

        return {};
      },
    });

    // Tick 1
    const r1 = await heartbeat.runTick("tenant-1", "manual");
    expect(r1.status).toBe("completed");
    expect(r1.actionsTakenCount).toBe(1);
    expect(r1.nextCadenceMs).toBe(120_000);
    expect(sideEffects).toEqual(["sent intro to Alice"]);

    // Verify goal was created
    const goalsAfter1 = await store.listGoals("tenant-1");
    expect(goalsAfter1).toHaveLength(1);
    expect(goalsAfter1[0].title).toBe("Engage Alice");

    // Tick 2
    const r2 = await heartbeat.runTick("tenant-1", "scheduled");
    expect(r2.status).toBe("completed");
    expect(r2.nextCadenceMs).toBe(86_400_000);

    // Goal completed
    const goal = await store.getGoal("goal-alice");
    expect(goal!.status).toBe("completed");

    expect(tickCount).toBe(2);
  });

  test("governance hard cap enforced across actions in a tick", async () => {
    const store = createTestStore();
    await store.upsertState("t1", { enabled: true });

    const results: DispatchResult[] = [];

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: { store, caps: { perPass: 2, perTick: 2 } },
      cadence: { min: 1_000, max: 100_000, default: 10_000 },
      tick: async (ctx) => {
        for (let i = 0; i < 3; i++) {
          results.push(await ctx.governance.dispatch({
            goalId: "g1",
            goalTickId: "gt1",
            actionType: `action_${i}`,
            target: { i },
            reasoning: "test",
            perform: async () => {},
          }));
        }
        return {};
      },
    });

    await heartbeat.runTick("t1", "manual");

    expect(results[0].governanceOutcome).toBe("taken");
    expect(results[1].governanceOutcome).toBe("taken");
    expect(results[2].governanceOutcome).toBe("hard_denied");
    expect(results[2].denialReason).toContain("Per-tick cap");
  });

  test("distinct nested targets are not collapsed into a duplicate", async () => {
    // The idempotency key must distinguish targets by their full nested shape.
    // A JSON.stringify replacer-array drops nested keys, collapsing different
    // targets to one key and silently hard-denying the second as a duplicate.
    const store = createTestStore();
    await store.upsertState("t1", { enabled: true });

    const results: DispatchResult[] = [];

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: { store, caps: { perPass: 5, perTick: 5 } },
      cadence: { min: 1_000, max: 100_000, default: 10_000 },
      tick: async (ctx) => {
        for (const id of ["C1", "C2"]) {
          results.push(await ctx.governance.dispatch({
            goalId: "g1",
            goalTickId: "gt1",
            actionType: "send_message",
            target: { channel: { id, type: "dm" } },
            reasoning: "test",
            perform: async () => {},
          }));
        }
        return {};
      },
    });

    await heartbeat.runTick("t1", "manual");

    expect(results[0].governanceOutcome).toBe("taken");
    expect(results[1].governanceOutcome).toBe("taken"); // not "hard_denied" duplicate
  });

  test("scheduler start → triggerNow → reschedule cycle", async () => {
    vi.useFakeTimers();
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    let ticksFired = 0;
    const adapter = createTimerAdapter();

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: { store, caps: { perPass: 3, perTick: 5 } },
      cadence: { min: 100, max: 10_000, default: 1_000 },
      tick: async () => {
        ticksFired++;
        return { cadenceHint: { nextTickMs: 500, reasoning: "fast" } };
      },
    });

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: { min: 100, max: 10_000, default: 1_000 },
      identity: (id) => `proactivity:${id}`,
      onTick: (entityId, trigger) => heartbeat.runTick(entityId, trigger),
    });

    // Wire timer fires → scheduler
    adapter.onFire(async (entityId) => {
      const result = await heartbeat.runTick(entityId, "scheduled");
      const nextMs = Math.max(100, Math.min(10_000, result.nextCadenceMs ?? 1_000));
      await adapter.enqueue({ entityId, delayMs: nextMs, jobId: `proactivity:${entityId}` });
      await store.upsertState(entityId, { nextScheduledTickAt: new Date(Date.now() + nextMs) });
    });

    // Start: enqueues first tick at default cadence (1000ms)
    await scheduler.start("e1");
    expect(ticksFired).toBe(0);

    // triggerNow: fires immediately, reschedules
    await scheduler.triggerNow("e1");
    expect(ticksFired).toBe(1);

    // Timer fires at 500ms (cadence hint from tick)
    vi.advanceTimersByTime(500);
    // Need to flush the async callback
    await vi.advanceTimersByTimeAsync(0);
    expect(ticksFired).toBe(2);

    vi.useRealTimers();
  });

  test("seedFromStore recovers scheduled entities after restart", async () => {
    const store = createTestStore();
    const futureTime = new Date(Date.now() + 5_000);
    await store.upsertState("e1", {
      enabled: true,
      nextScheduledTickAt: futureTime,
    });
    await store.upsertState("e2", {
      enabled: true,
      nextScheduledTickAt: new Date(Date.now() + 10_000),
    });
    // e3 has no schedule — should not be re-enqueued
    await store.upsertState("e3", {
      enabled: true,
    });

    const enqueuedJobs: string[] = [];
    const adapter = createTimerAdapter();
    const origEnqueue = adapter.enqueue.bind(adapter);
    adapter.enqueue = async (opts) => {
      enqueuedJobs.push(opts.entityId);
      return origEnqueue(opts);
    };

    const scheduler = createScheduler({
      adapter,
      store,
      cadence: { min: 1_000, max: 100_000, default: 10_000 },
      identity: (id) => `job:${id}`,
      onTick: async () => ({ tickId: "t", status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: 10_000 }),
    });

    await scheduler.seedFromStore();

    expect(enqueuedJobs).toContain("e1");
    expect(enqueuedJobs).toContain("e2");
    expect(enqueuedJobs).not.toContain("e3");
  });

  test("idempotency prevents duplicate side effects within a tick", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    let performCount = 0;
    const results: DispatchResult[] = [];

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: { store, caps: { perPass: 10, perTick: 10 } },
      cadence: { min: 1_000, max: 100_000, default: 10_000 },
      tick: async (ctx) => {
        // Dispatch same action twice (same type + same target = same idempotency key)
        for (let i = 0; i < 2; i++) {
          results.push(await ctx.governance.dispatch({
            goalId: "g1",
            goalTickId: "gt1",
            actionType: "send_message",
            target: { userId: "alice" },
            reasoning: "test",
            perform: async () => { performCount++; },
          }));
        }
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");

    expect(results[0].governanceOutcome).toBe("taken");
    expect(results[1].governanceOutcome).toBe("hard_denied");
    expect(results[1].denialReason).toContain("Duplicate");
    expect(performCount).toBe(1);
  });

  test("failed tick still returns valid result for rescheduling", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: { store, caps: { perPass: 3, perTick: 5 } },
      cadence: { min: 1_000, max: 100_000, default: 30_000 },
      tick: async () => { throw new Error("LLM provider down"); },
    });

    const result = await heartbeat.runTick("e1", "scheduled");

    expect(result.status).toBe("failed");
    expect(result.nextCadenceMs).toBe(30_000); // falls back to default

    const tick = await store.getLatestTick("e1");
    expect(tick!.status).toBe("failed");
    expect(tick!.error).toBe("LLM provider down");
  });
});

describe("E2E: plan/act heartbeat", () => {
  test("planner creates goals, executor works them, cross-goal governance shared", async () => {
    const store = createTestStore();
    await store.upsertState("org-1", { enabled: true });

    const sideEffects: string[] = [];

    const heartbeat = createPlanActHeartbeat({
      store,
      sources: [{ name: "signals", load: async () => ({ churnRisk: ["user-a"], newFeature: "analytics" }) }],
      governance: { store, caps: { perPass: 2, perTick: 3 } },
      cadence: { min: 60_000, max: 86_400_000, default: 3_600_000 },
      tick: async () => ({}),
      planner: async (ctx) => {
        expect(ctx.briefing.signals).toBeDefined();
        return {
          goalMutations: [
            {
              op: "create",
              goalId: "g-churn",
              title: "Retain user-a",
              objective: "Reach out before churn",
              doneCondition: "User-a engages",
              findings: "Churn risk signal",
              reasoning: "High-value user flagged",
            },
            {
              op: "create",
              goalId: "g-announce",
              title: "Announce analytics",
              objective: "Notify about new feature",
              doneCondition: "Announcement sent",
              findings: "New feature shipped",
              reasoning: "Drive adoption",
            },
          ],
          selectedGoals: [
            { goalId: "g-churn", reasoning: "churn is urgent" },
            { goalId: "g-announce", reasoning: "time-sensitive" },
          ],
          skippedGoals: [],
          cadenceHint: { nextTickMs: 7_200_000, reasoning: "wait for responses" },
        };
      },
      executor: async (ctx: ExecutorContext) => {
        const r = await ctx.governance.dispatch({
          goalId: ctx.goal.id,
          goalTickId: "gt-auto",
          actionType: "send_message",
          target: { userId: ctx.goal.id === "g-churn" ? "user-a" : "all-users" },
          reasoning: `Working goal: ${ctx.goal.title}`,
          perform: async () => { sideEffects.push(`executed:${ctx.goal.id}`); },
        });

        return {
          acted: r.governanceOutcome === "taken",
          summary: r.governanceOutcome === "taken" ? "Sent message" : `Denied: ${r.denialReason}`,
        };
      },
    });

    const result = await heartbeat.runTick("org-1", "manual");

    expect(result.status).toBe("completed");
    expect(result.goalsWorkedCount).toBe(2);
    expect(result.actionsTakenCount).toBe(2);
    expect(result.nextCadenceMs).toBe(7_200_000);
    expect(sideEffects).toEqual(["executed:g-churn", "executed:g-announce"]);

    // Goals persisted
    const goals = await store.listGoals("org-1");
    expect(goals).toHaveLength(2);
  });

  test("per-tick cap shared across executor passes", async () => {
    const store = createTestStore();
    await store.upsertState("org-1", { enabled: true });

    // Seed goals
    const { tickId: seedTick } = await store.insertTick({ entityId: "org-1", trigger: "manual", dryRun: false });
    await store.applyGoalMutations(seedTick, [
      { op: "create", goalId: "g1", title: "G1", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
      { op: "create", goalId: "g2", title: "G2", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);
    await store.updateTick(seedTick, { status: "completed", completedAt: new Date() });

    const outcomes: string[] = [];

    const heartbeat = createPlanActHeartbeat({
      store,
      sources: [],
      governance: { store, caps: { perPass: 5, perTick: 1 } }, // only 1 action per tick total
      cadence: { min: 1_000, max: 100_000, default: 10_000 },
      tick: async () => ({}),
      planner: async () => ({
        goalMutations: [],
        selectedGoals: [
          { goalId: "g1", reasoning: "first" },
          { goalId: "g2", reasoning: "second" },
        ],
        skippedGoals: [],
      }),
      executor: async (ctx) => {
        const r = await ctx.governance.dispatch({
          goalId: ctx.goal.id,
          goalTickId: "gt",
          actionType: "action",
          target: { goal: ctx.goal.id },
          reasoning: "test",
          perform: async () => {},
        });
        outcomes.push(`${ctx.goal.id}:${r.governanceOutcome}`);
        return { acted: r.governanceOutcome === "taken", summary: r.governanceOutcome };
      },
    });

    await heartbeat.runTick("org-1", "manual");

    // First executor takes, second is denied by per-tick cap
    expect(outcomes).toEqual(["g1:taken", "g2:hard_denied"]);
  });
});

describe("E2E: delta-aware briefing", () => {
  test("briefing source receives correct delta cutoff across ticks", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const cutoffs: (Date | null)[] = [];

    const heartbeat = createHeartbeat({
      store,
      sources: [{
        name: "events",
        load: async (boundary) => {
          cutoffs.push(boundary.previousTickStartedAt);
          return { events: [] };
        },
      }],
      governance: { store, caps: { perPass: 3, perTick: 5 } },
      cadence: { min: 1_000, max: 100_000, default: 10_000 },
      tick: async () => ({}),
    });

    await heartbeat.runTick("e1", "manual");
    await heartbeat.runTick("e1", "scheduled");
    await heartbeat.runTick("e1", "scheduled");

    // First tick has no previous
    expect(cutoffs[0]).toBeNull();
    // Second tick's cutoff = first tick's startedAt
    expect(cutoffs[1]).toBeInstanceOf(Date);
    // Third tick's cutoff = second tick's startedAt, later than first
    expect(cutoffs[2]).toBeInstanceOf(Date);
    expect(cutoffs[2]!.getTime()).toBeGreaterThanOrEqual(cutoffs[1]!.getTime());
  });
});
