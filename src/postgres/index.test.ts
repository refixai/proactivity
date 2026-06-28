import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createPostgresStore } from "./index.js";
import type { GoalMutation, InsertAttempt } from "../core/types.js";

const CONNECTION_STRING = "postgresql://refix:refix-password@localhost:5432/proactivity_test";

const pool = new pg.Pool({ connectionString: CONNECTION_STRING });

const makeStore = () => createPostgresStore({ pool });

const seedGoalAndGoalTick = async (store: ReturnType<typeof makeStore>, entityId: string, tickId: string) => {
  await store.applyGoalMutations(tickId, [
    { op: "create", goalId: `goal-${tickId}`, title: "G", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
  ]);
  const gtId = await store.insertGoalTick({ goalId: `goal-${tickId}`, tickId, orderIndex: 0 });
  return { goalId: `goal-${tickId}`, goalTickId: gtId };
};

beforeAll(async () => {
  const store = makeStore();
  await store.migrate();
});

beforeEach(async () => {
  // Clean tables in dependency order
  await pool.query("DELETE FROM proactivity_attempts");
  await pool.query("DELETE FROM proactivity_goal_ticks");
  await pool.query("DELETE FROM proactivity_goals");
  await pool.query("DELETE FROM proactivity_ticks");
  await pool.query("DELETE FROM proactivity_state");
});

afterAll(async () => {
  await pool.end();
});

describe("createPostgresStore", () => {
  // --- Entity State ---

  test("upsertState creates and updates entity", async () => {
    const store = makeStore();
    expect(await store.getState("e1")).toBeNull();

    await store.upsertState("e1", { enabled: true });
    const state = await store.getState("e1");
    expect(state).toMatchObject({ entityId: "e1", enabled: true });

    await store.upsertState("e1", { enabled: false });
    expect((await store.getState("e1"))!.enabled).toBe(false);
  });

  // --- Ticks ---

  test("insertTick and getLatestTick round-trip", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });

    const { tickId } = await store.insertTick({
      entityId: "e1",
      trigger: "manual",
      dryRun: false,
    });
    expect(typeof tickId).toBe("string");

    const latest = await store.getLatestTick("e1");
    expect(latest).toMatchObject({
      id: tickId,
      entityId: "e1",
      status: "running",
    });
  });

  test("updateTick patches tick fields", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });

    const { tickId } = await store.insertTick({
      entityId: "e1",
      trigger: "scheduled",
      dryRun: false,
    });

    await store.updateTick(tickId, {
      status: "completed",
      completedAt: new Date(),
      actionsTakenCount: 2,
      cadenceHintMs: 60_000,
    });

    const tick = await store.getLatestTick("e1");
    expect(tick!.status).toBe("completed");
    expect(tick!.actionsTakenCount).toBe(2);
    expect(tick!.cadenceHintMs).toBe(60_000);
  });

  test("getPreviousTickStartedAt returns prior tick time", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });

    await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    await store.insertTick({ entityId: "e1", trigger: "scheduled", dryRun: false });

    const prev = await store.getPreviousTickStartedAt("e1", 2);
    expect(prev).toBeInstanceOf(Date);

    const noPrev = await store.getPreviousTickStartedAt("e1", 1);
    expect(noPrev).toBeNull();
  });

  // --- Goals ---

  test("applyGoalMutations creates goals", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    const mutations: GoalMutation[] = [
      {
        op: "create",
        title: "Increase engagement",
        objective: "Send weekly digest",
        doneCondition: "3 digests sent",
        findings: "",
        reasoning: "Signal observed",
      },
    ];

    await store.applyGoalMutations(tickId, mutations);
    const goals = await store.listGoals("e1");
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe("Increase engagement");
    expect(goals[0].status).toBe("active");
  });

  test("applyGoalMutations rolls back the whole batch on a mid-batch failure", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    // First create succeeds; the second reuses the same id → primary-key
    // violation mid-batch. All-or-nothing means the first insert rolls back too.
    const mutations: GoalMutation[] = [
      { op: "create", goalId: "g-rollback", title: "A", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
      { op: "create", goalId: "g-rollback", title: "B", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ];

    await expect(store.applyGoalMutations(tickId, mutations)).rejects.toThrow();

    const goals = await store.listGoals("e1");
    expect(goals).toHaveLength(0);
  });

  test("applyGoalMutations updates, completes, archives goals", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    await store.applyGoalMutations(tickId, [
      { op: "create", title: "Test goal", objective: "obj", doneCondition: "done", findings: "", reasoning: "test" },
    ]);

    const [goal] = await store.listGoals("e1");

    await store.applyGoalMutations(tickId, [
      { op: "update", goalId: goal.id, findings: "new finding", reasoning: "learned something" },
    ]);
    expect((await store.getGoal(goal.id))!.findings).toBe("new finding");

    await store.applyGoalMutations(tickId, [
      { op: "complete", goalId: goal.id, reasoning: "done condition met" },
    ]);
    expect((await store.getGoal(goal.id))!.status).toBe("completed");

    await store.applyGoalMutations(tickId, [
      { op: "archive", goalId: goal.id, reasoning: "cleaning up" },
    ]);
    expect((await store.getGoal(goal.id))!.status).toBe("archived");
  });

  test("listGoals filters by status", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    await store.applyGoalMutations(tickId, [
      { op: "create", title: "Active goal", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
      { op: "create", title: "Will archive", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);

    const goals = await store.listGoals("e1");
    await store.applyGoalMutations(tickId, [
      { op: "archive", goalId: goals[1].id, reasoning: "stale" },
    ]);

    const active = await store.listGoals("e1", { status: ["active"] });
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe("Active goal");
  });

  // --- Goal Ticks ---

  test("insertGoalTick and updateGoalTick round-trip", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    await store.applyGoalMutations(tickId, [
      { op: "create", title: "G", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);
    const [goal] = await store.listGoals("e1");

    const gtId = await store.insertGoalTick({ goalId: goal.id, tickId, orderIndex: 0 });
    expect(typeof gtId).toBe("string");

    await store.updateGoalTick(gtId, { acted: true, summary: "sent message" });
  });

  // --- Attempts ---

  test("insertAttempt and idempotency conflict", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    const { goalId, goalTickId } = await seedGoalAndGoalTick(store, "e1", tickId);

    const base: InsertAttempt = {
      goalId,
      tickId,
      goalTickId,
      actionType: "send_message",
      idempotencyKey: "key-1",
      governanceOutcome: "taken",
      reasoning: "test",
      denialReason: null,
      overrideReason: null,
      target: { userId: "u1" },
      payload: null,
    };

    const first = await store.insertAttempt(base);
    expect(first.kind).toBe("inserted");

    const dup = await store.insertAttempt(base);
    expect(dup.kind).toBe("idempotency_conflict");
  });

  test("markAttemptCompleted and markAttemptFailed", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    const { goalId, goalTickId } = await seedGoalAndGoalTick(store, "e1", tickId);

    const r1 = await store.insertAttempt({
      goalId, tickId, goalTickId,
      actionType: "a", idempotencyKey: "k1",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });
    if (r1.kind !== "inserted") throw new Error("expected inserted");
    await store.markAttemptCompleted(r1.attemptId);

    const r2 = await store.insertAttempt({
      goalId, tickId, goalTickId,
      actionType: "b", idempotencyKey: "k2",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });
    if (r2.kind !== "inserted") throw new Error("expected inserted");
    await store.markAttemptFailed(r2.attemptId, "boom");

    const attempts = await store.listAttempts(tickId);
    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.id === r1.attemptId)!.completedAt).toBeInstanceOf(Date);
    expect(attempts.find((a) => a.id === r2.attemptId)!.error).toBe("boom");
  });

  test("getRecentAttempts returns attempts within tick window", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });

    const { tickId: t1 } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    const s1 = await seedGoalAndGoalTick(store, "e1", t1);
    await store.insertAttempt({
      goalId: s1.goalId, tickId: t1, goalTickId: s1.goalTickId,
      actionType: "a", idempotencyKey: "k1",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });

    const { tickId: t2 } = await store.insertTick({ entityId: "e1", trigger: "scheduled", dryRun: false });
    const s2 = await seedGoalAndGoalTick(store, "e1", t2);
    await store.insertAttempt({
      goalId: s2.goalId, tickId: t2, goalTickId: s2.goalTickId,
      actionType: "b", idempotencyKey: "k2",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });

    const recent = await store.getRecentAttempts("e1", { tickWindow: 2 });
    expect(recent).toHaveLength(2);

    const recent1 = await store.getRecentAttempts("e1", { tickWindow: 1 });
    expect(recent1).toHaveLength(1);
  });

  // --- listSchedulableEntities ---

  test("listSchedulableEntities returns enabled entities with scheduled ticks", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true, nextScheduledTickAt: new Date() });
    await store.upsertState("e2", { enabled: false, nextScheduledTickAt: new Date() });
    await store.upsertState("e3", { enabled: true });

    const schedulable = await store.listSchedulableEntities();
    expect(schedulable).toHaveLength(1);
    expect(schedulable[0].entityId).toBe("e1");
  });

  // --- migrate idempotent ---

  test("migrate is idempotent", async () => {
    const store = makeStore();
    await store.migrate();
    await store.migrate();
  });

  // --- E2E: heartbeat against real Postgres ---

  test("full heartbeat tick lifecycle against Postgres", async () => {
    const { createHeartbeat } = await import("../core/heartbeat.js");
    const store = makeStore();

    await store.upsertState("org-1", { enabled: true });

    const performed: string[] = [];

    const heartbeat = createHeartbeat({
      store,
      sources: [{ name: "crm", load: async () => ({ lead: "Alice" }) }],
      governance: { store, caps: { perPass: 3, perTick: 5 } },
      cadence: { min: 60_000, max: 86_400_000, default: 3_600_000 },
      tick: async (ctx) => {
        expect(ctx.briefing.crm).toEqual({ lead: "Alice" });

        await store.applyGoalMutations(ctx.boundary.tickId, [
          { op: "create", goalId: "g-alice", title: "Engage Alice", objective: "Send intro", doneCondition: "Reply", findings: "", reasoning: "New lead" },
        ]);
        const gtId = await store.insertGoalTick({ goalId: "g-alice", tickId: ctx.boundary.tickId, orderIndex: 0 });

        const r = await ctx.governance.dispatch({
          goalId: "g-alice",
          goalTickId: gtId,
          actionType: "send_email",
          target: { to: "alice@example.com" },
          reasoning: "Intro to new lead",
          perform: async () => { performed.push("email sent"); },
        });
        expect(r.governanceOutcome).toBe("taken");

        return { cadenceHint: { nextTickMs: 120_000, reasoning: "follow up" } };
      },
    });

    const result = await heartbeat.runTick("org-1", "manual");

    expect(result.status).toBe("completed");
    expect(result.actionsTakenCount).toBe(1);
    expect(result.nextCadenceMs).toBe(120_000);
    expect(performed).toEqual(["email sent"]);

    // Verify persisted in Postgres
    const tick = await store.getLatestTick("org-1");
    expect(tick!.status).toBe("completed");
    expect(tick!.actionsTakenCount).toBe(1);

    const goals = await store.listGoals("org-1");
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe("Engage Alice");

    const attempts = await store.listAttempts(tick!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].governanceOutcome).toBe("taken");
    expect(attempts[0].completedAt).toBeInstanceOf(Date);
  });
});
