import { describe, test, expect } from "vitest";
import { createTestStore } from "./index.js";
import type {
  GoalMutation,
  GoalRecord,
  InsertAttempt,
} from "../core/types.js";

const makeStore = () => {
  const store = createTestStore();
  return store;
};

describe("createTestStore", () => {
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

  test("upsertState round-trips the ledger summary fields", async () => {
    const store = makeStore();
    await store.upsertState("e1", { enabled: true });
    expect((await store.getState("e1"))!.ledgerSummary).toBeNull();

    await store.upsertState("e1", {
      ledgerSummary: "Wakes 1-3: watched two tickets, briefed once.",
      ledgerSummaryThroughTick: 3,
    });
    const state = (await store.getState("e1"))!;
    expect(state.ledgerSummary).toContain("briefed once");
    expect(state.ledgerSummaryThroughTick).toBe(3);
    // Unrelated patches must not clobber the summary.
    await store.upsertState("e1", { lastTickAt: new Date() });
    expect((await store.getState("e1"))!.ledgerSummaryThroughTick).toBe(3);
  });

  // --- Ticks ---

  test("insertTick and getLatestTick round-trip", async () => {
    const store = makeStore();
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

    await store.applyGoalMutations("e1", mutations);
    const goals = await store.listGoals("e1");
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe("Increase engagement");
    expect(goals[0].status).toBe("active");
  });

  test("applyGoalMutations updates, completes, archives goals", async () => {
    const store = makeStore();
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    await store.applyGoalMutations("e1", [
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

    await store.applyGoalMutations("e1", [
      { op: "update", goalId: goal.id, findings: "new finding", reasoning: "learned something" },
    ]);
    const updated = (await store.getGoal(goal.id))!;
    expect(updated.findings).toBe("new finding");

    await store.applyGoalMutations("e1", [
      { op: "complete", goalId: goal.id, reasoning: "done condition met" },
    ]);
    expect((await store.getGoal(goal.id))!.status).toBe("completed");

    await store.applyGoalMutations("e1", [
      { op: "archive", goalId: goal.id, reasoning: "cleaning up" },
    ]);
    expect((await store.getGoal(goal.id))!.status).toBe("archived");
  });

  test("update status resumes a paused goal", async () => {
    const store = makeStore();
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    await store.applyGoalMutations("e1", [
      { op: "create", goalId: "g1", title: "T", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);
    await store.applyGoalMutations("e1", [
      { op: "pause", goalId: "g1", reasoning: "waiting on user" },
    ]);
    expect((await store.getGoal("g1"))!.status).toBe("paused");

    await store.applyGoalMutations("e1", [
      { op: "update", goalId: "g1", status: "active", reasoning: "user replied" },
    ]);
    expect((await store.getGoal("g1"))!.status).toBe("active");
  });

  test("listTicksInRange returns the window oldest-first, bounded", async () => {
    const store = makeStore();
    for (let i = 0; i < 6; i++) {
      await store.insertTick({ entityId: "e1", trigger: "scheduled", dryRun: false });
    }
    await store.insertTick({ entityId: "e2", trigger: "scheduled", dryRun: false });

    const range = await store.listTicksInRange("e1", { afterTick: 1, throughTick: 4, limit: 10 });
    expect(range.map((t) => t.tickNumber)).toEqual([2, 3, 4]);

    const capped = await store.listTicksInRange("e1", { afterTick: 0, throughTick: 6, limit: 2 });
    expect(capped.map((t) => t.tickNumber)).toEqual([1, 2]);
  });

  test("pinned persists on create and is updatable", async () => {
    const store = makeStore();
    await store.applyGoalMutations("e1", [
      { op: "create", goalId: "g-pin", title: "Standing", objective: "o", doneCondition: "d", pinned: true, reasoning: "seed" },
      { op: "create", goalId: "g-plain", title: "Normal", objective: "o", doneCondition: "d", reasoning: "seed" },
    ]);
    expect((await store.getGoal("g-pin"))!.pinned).toBe(true);
    expect((await store.getGoal("g-plain"))!.pinned).toBe(false);

    await store.applyGoalMutations("e1", [
      { op: "update", goalId: "g-pin", pinned: false, reasoning: "config unpinned it" },
    ]);
    expect((await store.getGoal("g-pin"))!.pinned).toBe(false);
  });

  test("applyGoalMutations can't mutate another entity's goal", async () => {
    const store = makeStore();
    // e1 owns a goal; e2's tick tries to archive it by id.
    const { tickId: t1 } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    await store.applyGoalMutations("e1", [
      { op: "create", goalId: "g-e1", title: "e1 goal", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);

    const { tickId: t2 } = await store.insertTick({ entityId: "e2", trigger: "manual", dryRun: false });
    await store.applyGoalMutations("e2", [
      { op: "archive", goalId: "g-e1", reasoning: "cross-entity attempt" },
    ]);

    expect((await store.getGoal("g-e1"))!.status).toBe("active");
  });

  test("listGoals filters by status", async () => {
    const store = makeStore();
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    await store.applyGoalMutations("e1", [
      { op: "create", title: "Active goal", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
      { op: "create", title: "Will archive", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
    ]);

    const goals = await store.listGoals("e1");
    await store.applyGoalMutations("e1", [
      { op: "archive", goalId: goals[1].id, reasoning: "stale" },
    ]);

    const active = await store.listGoals("e1", { status: ["active"] });
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe("Active goal");
  });

  // --- Goal Ticks ---

  test("insertGoalTick and updateGoalTick round-trip", async () => {
    const store = makeStore();
    const { tickId } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });

    await store.applyGoalMutations("e1", [
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

    const { tickId: t1 } = await store.insertTick({ entityId: "e1", trigger: "manual", dryRun: false });
    await store.insertAttempt({
      goalId: "g1", tickId: t1, goalTickId: "gt1",
      actionType: "a", idempotencyKey: "k1",
      governanceOutcome: "taken", reasoning: "r",
      denialReason: null, overrideReason: null,
      target: {}, payload: null,
    });

    const { tickId: t2 } = await store.insertTick({ entityId: "e1", trigger: "scheduled", dryRun: false });
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
