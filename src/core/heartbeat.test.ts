import { describe, test, expect, vi } from "vitest";
import { createHeartbeat, createPlanActHeartbeat } from "./heartbeat.js";
import { createTestStore } from "../memory/index.js";
import type {
  HeartbeatConfig,
  PlanActConfig,
  TickContext,
  GovernanceConfig,
} from "./types.js";

const makeGovernanceConfig = (store: ReturnType<typeof createTestStore>): GovernanceConfig => ({
  store,
  caps: { perPass: 3, perTick: 5 },
});

const makeCadenceConfig = () => ({
  min: 60_000,
  max: 86_400_000,
  default: 3_600_000,
});

describe("createHeartbeat", () => {
  test("full tick lifecycle: briefing → callback → result", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const tickFn = vi.fn(async (ctx: TickContext) => {
      expect(ctx.briefing).toEqual({ signals: { event: "user_login" } });
      expect(ctx.goals).toEqual([]);
      expect(ctx.boundary.entityId).toBe("e1");
      expect(ctx.boundary.tickNumber).toBe(1);
      return { cadenceHint: { nextTickMs: 120_000, reasoning: "checking back" } };
    });

    const heartbeat = createHeartbeat({
      store,
      sources: [{ name: "signals", load: async () => ({ event: "user_login" }) }],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      tick: tickFn,
    });

    const result = await heartbeat.runTick("e1", "manual");

    expect(result.status).toBe("completed");
    expect(result.nextCadenceMs).toBe(120_000);
    expect(tickFn).toHaveBeenCalledOnce();

    const tick = await store.getLatestTick("e1");
    expect(tick!.status).toBe("completed");
    expect(tick!.completedAt).toBeInstanceOf(Date);
  });

  test("governance dispatch works inside tick callback", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const performed = vi.fn();

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        const result = await ctx.governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
          actionType: "send_message",
          target: { userId: "u1" },
          reasoning: "test",
          perform: performed,
        });
        expect(result.governanceOutcome).toBe("taken");
        return {};
      },
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(result.actionsTakenCount).toBe(1);
    expect(performed).toHaveBeenCalledOnce();
  });

  test("tick number increments across runs", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const tickNumbers: number[] = [];
    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        tickNumbers.push(ctx.boundary.tickNumber);
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    await heartbeat.runTick("e1", "scheduled");

    expect(tickNumbers).toEqual([1, 2]);
  });

  test("delta cutoff uses previous tick startedAt", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    let firstTickStartedAt: Date | undefined;
    let secondDeltaCutoff: Date | undefined;

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        if (ctx.boundary.tickNumber === 1) {
          firstTickStartedAt = ctx.boundary.startedAt;
        } else {
          secondDeltaCutoff = ctx.boundary.deltaCutoff;
        }
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    await heartbeat.runTick("e1", "manual");

    expect(secondDeltaCutoff).toEqual(firstTickStartedAt);
  });

  test("cadence hint null defaults to config.default", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      tick: async () => ({}),
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(result.nextCadenceMs).toBe(3_600_000);
  });

  test("tick callback error results in failed tick", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      tick: async () => {
        throw new Error("LLM timeout");
      },
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(result.status).toBe("failed");
    expect(result.nextCadenceMs).toBe(3_600_000);

    const tick = await store.getLatestTick("e1");
    expect(tick!.status).toBe("failed");
    expect(tick!.error).toBe("LLM timeout");
  });

  test("dry run mode passes through to governance", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const performed = vi.fn();

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: { ...makeGovernanceConfig(store), dryRun: true },
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        const r = await ctx.governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
          actionType: "send_message",
          target: { userId: "u1" },
          reasoning: "test",
          perform: performed,
        });
        expect(r.governanceOutcome).toBe("pending_approval");
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    expect(performed).not.toHaveBeenCalled();
  });

  test("dry-run actions consume cap budget like live ones", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const outcomes: string[] = [];

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: { store, caps: { perPass: 5, perTick: 2 }, dryRun: true },
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        for (let i = 0; i < 3; i++) {
          const r = await ctx.governance.dispatch({
            goalId: "g1",
            goalTickId: "gt1",
            actionType: "send_message",
            target: { userId: `u${i}` },
            reasoning: "test",
            perform: async () => {},
          });
          outcomes.push(r.governanceOutcome);
        }
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    // The third draft is denied: a dry run must preview the same action
    // volume live mode would allow, or the operator reviews a fantasy.
    expect(outcomes).toEqual(["pending_approval", "pending_approval", "hard_denied"]);
  });

  test("cadence reasoning is persisted on the tick row", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      tick: async () => ({
        cadenceHint: { nextTickMs: 120_000, reasoning: "watching a fresh signal" },
      }),
    });

    await heartbeat.runTick("e1", "manual");

    const tick = await store.getLatestTick("e1");
    expect(tick!.cadenceHintMs).toBe(120_000);
    expect(tick!.cadenceReasoning).toBe("watching a fresh signal");
  });

  test("soft cap denies action without override", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const performed = vi.fn();

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: {
        ...makeGovernanceConfig(store),
        softCaps: [{
          name: "rate_limit",
          evaluate: () => ({ triggered: true, warning: "Too many messages recently" }),
        }],
      },
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        const r = await ctx.governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
          actionType: "send_message",
          target: { userId: "u1" },
          reasoning: "test",
          perform: performed,
        });
        expect(r.governanceOutcome).toBe("soft_cap_denied");
        expect(r.denialReason).toContain("Too many messages recently");
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    expect(performed).not.toHaveBeenCalled();
  });

  test("soft cap allows action with override reason", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const performed = vi.fn();

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: {
        ...makeGovernanceConfig(store),
        softCaps: [{
          name: "rate_limit",
          evaluate: () => ({ triggered: true, warning: "Too many messages recently" }),
        }],
      },
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        const r = await ctx.governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
          actionType: "send_message",
          target: { userId: "u1" },
          reasoning: "test",
          overrideReason: "Critical alert",
          perform: performed,
        });
        expect(r.governanceOutcome).toBe("soft_cap_overridden");
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    expect(performed).toHaveBeenCalledOnce();
  });

  test("soft cap denial is retriable by re-dispatching with an overrideReason", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const performed = vi.fn();

    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: {
        ...makeGovernanceConfig(store),
        softCaps: [{
          name: "recent_contact",
          evaluate: () => ({ triggered: true, warning: "Contacted recently" }),
        }],
      },
      cadence: makeCadenceConfig(),
      tick: async (ctx) => {
        const request = {
          goalId: "g1",
          goalTickId: "gt1",
          actionType: "send_message",
          target: { userId: "u1" },
          reasoning: "test",
          perform: async () => { performed(); },
        };

        const denied = await ctx.governance.dispatch(request);
        expect(denied.governanceOutcome).toBe("soft_cap_denied");

        // The denial's audit row must not have burned the idempotency key —
        // the same action retried with an override goes through.
        const retried = await ctx.governance.dispatch({
          ...request,
          overrideReason: "user asked for this explicitly",
        });
        expect(retried.governanceOutcome).toBe("soft_cap_overridden");
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    expect(performed).toHaveBeenCalledOnce();
  });

  test("entityCreatedAt provides delta cutoff for first tick", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const entityCreated = new Date("2025-01-01");

    let deltaCutoff: Date | undefined;
    const heartbeat = createHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      entityCreatedAt: async () => entityCreated,
      tick: async (ctx) => {
        deltaCutoff = ctx.boundary.deltaCutoff;
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    expect(deltaCutoff).toEqual(entityCreated);
  });
});

describe("createPlanActHeartbeat", () => {
  test("planner then executor lifecycle", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    await store.applyGoalMutations(tickId, [
      { op: "create", goalId: "g1", title: "Test", objective: "obj", doneCondition: "done", findings: "", reasoning: "seed" },
    ]);
    await store.updateTick(tickId, { status: "completed", completedAt: new Date() });

    const plannerCalled = vi.fn();
    const executorCalled = vi.fn();

    const heartbeat = createPlanActHeartbeat({
      store,
      sources: [{ name: "data", load: async () => ({ x: 1 }) }],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      planner: async (ctx) => {
        plannerCalled();
        expect(ctx.goals).toHaveLength(1);
        return {
          goalMutations: [],
          selectedGoals: [{ goalId: "g1", reasoning: "work it" }],
          skippedGoals: [],
          cadenceHint: { nextTickMs: 300_000, reasoning: "follow up" },
        };
      },
      executor: async (ctx) => {
        executorCalled();
        expect(ctx.goal.id).toBe("g1");
        await ctx.governance.dispatch({
          goalId: ctx.goal.id,
          goalTickId: ctx.goalTickId,
          actionType: "act",
          target: { goalId: ctx.goal.id },
          reasoning: "work the goal",
          perform: async () => {},
        });
        return { summary: "did thing" };
      },
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(plannerCalled).toHaveBeenCalledOnce();
    expect(executorCalled).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
    expect(result.goalsWorkedCount).toBe(1);
    expect(result.nextCadenceMs).toBe(300_000);

    const tick = await store.getLatestTick("e1");
    expect(tick!.cadenceReasoning).toBe("follow up");
  });

  test("acted is derived from the governance ledger, not the executor's report", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    await store.applyGoalMutations(tickId, [
      { op: "create", goalId: "g-liar", title: "L", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
      { op: "create", goalId: "g-crash", title: "C", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);
    await store.updateTick(tickId, { status: "completed", completedAt: new Date() });

    const heartbeat = createPlanActHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      planner: async () => ({
        goalMutations: [],
        selectedGoals: [
          { goalId: "g-liar", reasoning: "first" },
          { goalId: "g-crash", reasoning: "second" },
        ],
        skippedGoals: [],
      }),
      executor: async (ctx) => {
        if (ctx.goal.id === "g-liar") {
          // Claims work happened but never dispatched — must not count.
          return { summary: "sent three emails (it did not)" };
        }
        // Dispatches for real, then crashes — the action still counts.
        await ctx.governance.dispatch({
          goalId: ctx.goal.id,
          goalTickId: ctx.goalTickId,
          actionType: "act",
          target: { goalId: ctx.goal.id },
          reasoning: "real work",
          perform: async () => {},
        });
        throw new Error("boom after acting");
      },
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(result.status).toBe("completed");
    expect(result.goalsWorkedCount).toBe(1);
    expect(result.actionsTakenCount).toBe(1);
  });

  test("executor dispatches through governance with the provided goalTickId", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    await store.applyGoalMutations(tickId, [
      { op: "create", goalId: "g1", title: "T", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);
    await store.updateTick(tickId, { status: "completed", completedAt: new Date() });

    const performed = vi.fn();

    const heartbeat = createPlanActHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      planner: async () => ({
        goalMutations: [],
        selectedGoals: [{ goalId: "g1", reasoning: "work it" }],
        skippedGoals: [],
      }),
      executor: async ({ goal, goalTickId, governance }) => {
        const { governanceOutcome } = await governance.dispatch({
          goalId: goal.id,
          goalTickId,
          actionType: "send_follow_up",
          target: { goalId: goal.id },
          reasoning: "follow up",
          perform: async () => { performed(); },
        });
        return { summary: `outcome: ${governanceOutcome}` };
      },
    });

    const result = await heartbeat.runTick("e1", "manual");

    expect(result.status).toBe("completed");
    expect(result.actionsTakenCount).toBe(1);
    expect(performed).toHaveBeenCalledOnce();

    const attempts = await store.listAttempts(result.tickId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.governanceOutcome).toBe("taken");
  });

  test("executor crash does not abort tick", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });

    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    await store.applyGoalMutations(tickId, [
      { op: "create", goalId: "g1", title: "G1", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
      { op: "create", goalId: "g2", title: "G2", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);
    await store.updateTick(tickId, { status: "completed", completedAt: new Date() });

    const executorCalls: string[] = [];

    const heartbeat = createPlanActHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      planner: async () => ({
        goalMutations: [],
        selectedGoals: [
          { goalId: "g1", reasoning: "first" },
          { goalId: "g2", reasoning: "second" },
        ],
        skippedGoals: [],
      }),
      executor: async (ctx) => {
        executorCalls.push(ctx.goal.id);
        if (ctx.goal.id === "g1") throw new Error("executor boom");
        await ctx.governance.dispatch({
          goalId: ctx.goal.id,
          goalTickId: ctx.goalTickId,
          actionType: "act",
          target: { goalId: ctx.goal.id },
          reasoning: "work the goal",
          perform: async () => {},
        });
        return { summary: "ok" };
      },
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(result.status).toBe("completed");
    expect(executorCalls).toEqual(["g1", "g2"]);
    expect(result.goalsWorkedCount).toBe(1);
  });

  test("invalid goal mutations from planner fail the tick before any are applied", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true });
    const applySpy = vi.spyOn(store, "applyGoalMutations");

    const executorCalled = vi.fn();
    const heartbeat = createPlanActHeartbeat({
      store,
      sources: [],
      governance: makeGovernanceConfig(store),
      cadence: makeCadenceConfig(),
      planner: async () => ({
        // archive without a goalId — the kind of malformed batch an LLM emits
        goalMutations: [{ op: "archive", reasoning: "drop the stale one" }],
        selectedGoals: [],
        skippedGoals: [],
      }),
      executor: async () => {
        executorCalled();
        return { summary: "" };
      },
    });

    const result = await heartbeat.runTick("e1", "manual");

    expect(result.status).toBe("failed");
    expect(applySpy).not.toHaveBeenCalled();
    expect(executorCalled).not.toHaveBeenCalled();

    const tick = await store.getLatestTick("e1");
    expect(tick!.error).toContain("missing goalId");
  });
});
