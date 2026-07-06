import { describe, expect, test } from "vitest";
import { createTestStore } from "../memory/index.js";
import { ensureSeededGoals, normalizeGoalSeeds, pinnedGoalIds } from "./seeds.js";

describe("goal seeding", () => {
  test("seeds persist pinnedness on the record", async () => {
    const store = createTestStore();
    const seeds = normalizeGoalSeeds([
      { id: "watch", title: "Watch", objective: "o", doneCondition: "d", pinned: true },
      { title: "Side quest", objective: "o", doneCondition: "d" },
    ]);

    const goals = await ensureSeededGoals(store, "e1", seeds);
    expect(goals.find((g) => g.id === "watch")!.pinned).toBe(true);
    expect(goals.find((g) => g.id === "side-quest")!.pinned).toBe(false);
    expect(pinnedGoalIds(goals)).toEqual(["watch"]);
  });

  test("re-seeding reconciles pinnedness when the config changed it", async () => {
    const store = createTestStore();
    await ensureSeededGoals(
      store,
      "e1",
      normalizeGoalSeeds([{ id: "watch", title: "Watch", objective: "o", doneCondition: "d", pinned: true }]),
    );

    const goals = await ensureSeededGoals(
      store,
      "e1",
      normalizeGoalSeeds([{ id: "watch", title: "Watch", objective: "o", doneCondition: "d" }]),
    );
    expect(goals.find((g) => g.id === "watch")!.pinned).toBe(false);
  });

  test("pinnedGoalIds derives from live records, not config", async () => {
    const store = createTestStore();
    // A goal added at runtime (no seed) with pinned: true is shielded too.
    await store.applyGoalMutations("e1", [
      { op: "create", goalId: "runtime-goal", title: "Added later", objective: "o", doneCondition: "d", pinned: true, reasoning: "handle.addGoal" },
    ]);
    const goals = await store.listGoals("e1", { status: ["active", "paused"] });
    expect(pinnedGoalIds(goals)).toEqual(["runtime-goal"]);
  });
});
