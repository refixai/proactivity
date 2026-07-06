// Goal seeding shared by every runtime shape of the wrapper (proactive()'s
// in-process loop, the Eve integration's hook). Declared goals get stable ids
// so seeding is idempotent across restarts and across stores.

import type { GoalRecord, ProactivityStore } from "../core/types.js";
import type { GoalSeed } from "./types.js";

// When the developer declares no goals, the loop still needs a standing goal —
// governed actions attribute to it and its scratchpad becomes the agent's
// memory. Pinned so reflection can evolve it but never close it.
export const FALLBACK_GOAL: GoalSeed = {
  id: "proactive-loop",
  title: "Run the proactive loop",
  objective: "Wake on cadence, review the situation, and act when something genuinely warrants it.",
  doneCondition: "Standing goal — never done.",
  priority: "medium",
  pinned: true,
};

const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "goal";

export const normalizeGoalSeeds = (goals?: GoalSeed[]): Array<GoalSeed & { id: string }> =>
  (goals?.length ? goals : [FALLBACK_GOAL]).map((seed) => ({
    ...seed,
    id: seed.id ?? slugify(seed.title),
  }));

// Create whichever declared goals don't exist yet (idempotent on stable ids),
// reconcile pinnedness when the config changed it (pinned lives on the record
// so runtime-added goals keep it — declared seeds stay the config's call),
// then return the entity's live active+paused portfolio.
export const ensureSeededGoals = async (
  store: ProactivityStore,
  entityId: string,
  seeds: Array<GoalSeed & { id: string }>,
): Promise<GoalRecord[]> => {
  const missing = [];
  for (const seed of seeds) {
    const existing = await store.getGoal(seed.id);
    if (!existing) {
      missing.push(seed);
    } else if (existing.pinned !== (seed.pinned ?? false)) {
      await store.applyGoalMutations(entityId, [
        {
          op: "update",
          goalId: seed.id,
          pinned: seed.pinned ?? false,
          reasoning: "Pinnedness changed in proactivity config",
        },
      ]);
    }
  }
  if (missing.length > 0) {
    await store.applyGoalMutations(
      entityId,
      missing.map((seed) => ({
        op: "create" as const,
        goalId: seed.id,
        title: seed.title,
        objective: seed.objective,
        doneCondition: seed.doneCondition,
        priority: seed.priority,
        pinned: seed.pinned ?? false,
        reasoning: "Declared in proactivity config",
      })),
    );
  }
  return store.listGoals(entityId, { status: ["active", "paused"] });
};

// The ids reflection must treat as untouchable, derived from the live
// portfolio (not the config) so runtime-added pinned goals are shielded too.
export const pinnedGoalIds = (goals: GoalRecord[]): string[] =>
  goals.filter((g) => g.pinned).map((g) => g.id);

const PRIORITY_RANK: Record<GoalRecord["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// The wake's primary goal — where governed actions attribute. Highest-priority
// active goal, ties broken by age (stable).
export const pickPrimaryGoal = (goals: GoalRecord[]): GoalRecord | undefined => {
  const active = goals.filter((g) => g.status === "active");
  return [...(active.length ? active : goals)].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
};
