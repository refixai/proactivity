import { describe, test, expect } from "vitest";
import { createMemoryStore } from "./index.js";
import type {
  GoalMutation,
  GoalRecord,
  InsertAttempt,
} from "../core/types.js";

const makeStore = () => {
  const store = createMemoryStore();
  return store;
};

describe("createMemoryStore", () => {
  // --- Entity State ---

  test("upsertState creates and updates entity", async () => {
    const store = makeStore();
    expect(await store.getState("e1")).toBeNull();

    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
    const state = await store.getState("e1");
    expect(state).toMatchObject({ entityId: "e1", enabled: true });

    await store.upsertState("e1", { enabled: false });
    expect((await store.getState("e1"))!.enabled).toBe(false);
  });

  // --- Ticks ---

  test("insertTick and getLatestTick round-trip", async () => {
    const store = makeStore();
    const tickId = await store.insertTick({
      entityId: "e1",
      tickNumber: 1,
      trigger: "manual",
      dryRun: false,
    });
    expect(typeof tickId).toBe("string");

    const latest = await store.getLatestTick("e1");
    expect(latest).toMatchObject({
      id: tickId,
      entityId: "e1",
      tickNumber: 1,
      status: "running",
    });
  });

  test("updateTick patches tick fields", async () => {
    const store = makeStore();
    const tickId = await store.insertTick({
      entityId: "e1",
      tickNumber: 1,
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
    await store.insertTick({ entityId: "e1", tickNumber: 1, trigger: "manual", dryRun: false });
    await store.insertTick({ entityId: "e1", tickNumber: 2, trigger: "scheduled", dryRun: false });

    const prev = await store.getPreviousTickStartedAt("e1", 2);
    expect(prev).toBeInstanceOf(Date);

    const noPrev = await store.getPreviousTickStartedAt("e1", 1);
    expect(noPrev).toBeNull();
  });

  // --- Goals ---

  test("applyGoalMutations creates goals", async () => {
    const store = makeStore();
    const tickId = await store.insertTick({ entityId: "e1", tickNumber: 1, trigger: "manual", dryRun: false });

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

  test("applyGoalMutations updates, completes, archives goals", async () => {
    const store = makeStore();
    const tickId = await store.insertTick({ entityId: "e1", tickNumber: 1, trigger: "manual", dryRun: false });

    await store.applyGoalMutations(tickId, [
      {
        op: "create",
        title: "Test goal",
        objective: "obj",
        doneCondition: "done",
        findings: "",
        reasoning: "test",
      },
    ]);

    const [goal] = await store.listGoals("e1");

    await store.applyGoalMutations(tickId, [
      { op: "update", goalId: goal.id, findings: "new finding", reasoning: "learned something" },
    ]);
    const updated = (await store.getGoal(goal.id))!;
    expect(updated.findings).toBe("new finding");

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
    const tickId = await store.insertTick({ entityId: "e1", tickNumber: 1, trigger: "manual", dryRun: false });

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
    const tickId = await store.insertTick({ entityId: "e1", tickNumber: 1, trigger: "manual", dryRun: false });

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
    const base: InsertAttempt = {
      goalId: "g1",
      tickId: "t1",
      goalTickId: "gt1",
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
    const r1 = await store.insertAttempt({
      goalId: "g1", tickId: "t1", goalTickId: "gt1",
      actionType: "a", idempotencyKey: "k1",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });
    if (r1.kind !== "inserted") throw new Error("expected inserted");
    await store.markAttemptCompleted(r1.attemptId);

    const r2 = await store.insertAttempt({
      goalId: "g1", tickId: "t1", goalTickId: "gt1",
      actionType: "b", idempotencyKey: "k2",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });
    if (r2.kind !== "inserted") throw new Error("expected inserted");
    await store.markAttemptFailed(r2.attemptId, "boom");

    const attempts = await store.listAttempts("t1");
    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.id === r1.attemptId)!.completedAt).toBeInstanceOf(Date);
    expect(attempts.find((a) => a.id === r2.attemptId)!.error).toBe("boom");
  });

  test("getRecentAttempts returns attempts within tick window", async () => {
    const store = makeStore();

    const t1 = await store.insertTick({ entityId: "e1", tickNumber: 1, trigger: "manual", dryRun: false });
    await store.insertAttempt({
      goalId: "g1", tickId: t1, goalTickId: "gt1",
      actionType: "a", idempotencyKey: "k1",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });

    const t2 = await store.insertTick({ entityId: "e1", tickNumber: 2, trigger: "scheduled", dryRun: false });
    await store.insertAttempt({
      goalId: "g1", tickId: t2, goalTickId: "gt2",
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

  // --- migrate is a no-op for memory ---

  test("migrate resolves", async () => {
    const store = makeStore();
    await expect(store.migrate()).resolves.toBeUndefined();
  });
});
