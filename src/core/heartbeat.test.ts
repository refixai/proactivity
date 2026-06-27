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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });

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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });

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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });

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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });

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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });

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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
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

  test("soft cap denies action without override", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
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
        expect(r.governanceOutcome).toBe("hard_denied");
        expect(r.denialReason).toContain("Too many messages recently");
        return {};
      },
    });

    await heartbeat.runTick("e1", "manual");
    expect(performed).not.toHaveBeenCalled();
  });

  test("soft cap allows action with override reason", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
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

  test("entityCreatedAt provides delta cutoff for first tick", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
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
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });

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
      tick: async () => ({}),
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
        return { acted: true, summary: "did thing" };
      },
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(plannerCalled).toHaveBeenCalledOnce();
    expect(executorCalled).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
    expect(result.goalsWorkedCount).toBe(1);
    expect(result.nextCadenceMs).toBe(300_000);
  });

  test("executor crash does not abort tick", async () => {
    const store = createTestStore();
    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });

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
        executorCalls.push(ctx.goal.id);
        if (ctx.goal.id === "g1") throw new Error("executor boom");
        return { acted: true, summary: "ok" };
      },
    });

    const result = await heartbeat.runTick("e1", "manual");
    expect(result.status).toBe("completed");
    expect(executorCalls).toEqual(["g1", "g2"]);
    expect(result.goalsWorkedCount).toBe(1);
  });
});
