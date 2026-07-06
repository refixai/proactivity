// Runtime goal management — the machinery behind handle.addGoal() /
// completeGoal() (and their Eve equivalents). Goals are ordinary store
// mutations; these helpers add the ergonomics — stable ids, idempotency,
// honest errors — so "my user clicked watch-this" is one call, not a store
// ceremony. Everything here is dev-authority: unlike reflection, it may
// create pinned goals and may complete them.

import type { GoalRecord, ProactivityStore } from "../core/types.js";
import { normalizeGoalSeeds } from "./seeds.js";
import type { GoalSeed } from "./types.js";

// Create a goal outside any wake. Idempotent like config seeding: if the id
// (explicit or slugified from the title) already exists for this entity, the
// existing record is returned untouched.
export const addGoal = async (
  store: ProactivityStore,
  entityId: string,
  goal: GoalSeed,
): Promise<GoalRecord> => {
  const [seed] = normalizeGoalSeeds([goal]);

  // The entity may not have woken yet — ensure its state row exists first
  // (the postgres store's goals table references it).
  await store.upsertState(entityId, {});

  const existing = await store.getGoal(seed.id);
  if (existing) {
    if (existing.entityId !== entityId) {
      throw new Error(
        `addGoal: goal id "${seed.id}" already belongs to entity "${existing.entityId}"`,
      );
    }
    return existing;
  }

  await store.applyGoalMutations(entityId, [
    {
      op: "create",
      goalId: seed.id,
      title: seed.title,
      objective: seed.objective,
      doneCondition: seed.doneCondition,
      priority: seed.priority,
      pinned: seed.pinned ?? false,
      reasoning: "Added at runtime via addGoal()",
    },
  ]);
  return (await store.getGoal(seed.id))!;
};

// Complete a goal outside any wake. Works on pinned goals too — the pinned
// shield binds reflection, not the developer. Throws (rather than no-ops) on
// unknown/foreign/terminal goals so API misuse is visible.
export const completeGoal = async (
  store: ProactivityStore,
  entityId: string,
  goalId: string,
  reason?: string,
): Promise<void> => {
  const goal = await store.getGoal(goalId);
  if (!goal || goal.entityId !== entityId) {
    throw new Error(`completeGoal: no goal "${goalId}" for entity "${entityId}"`);
  }
  if (goal.status === "completed" || goal.status === "archived") {
    throw new Error(`completeGoal: goal "${goalId}" is already ${goal.status}`);
  }
  await store.applyGoalMutations(entityId, [
    {
      op: "complete",
      goalId,
      reasoning: reason ?? "Completed at runtime via completeGoal()",
    },
  ]);
};
