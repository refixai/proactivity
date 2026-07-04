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

export type NormalizedSeeds = {
  seeds: Array<GoalSeed & { id: string }>;
  pinnedGoalIds: string[];
};

export const normalizeGoalSeeds = (goals?: GoalSeed[]): NormalizedSeeds => {
  const seeds = (goals?.length ? goals : [FALLBACK_GOAL]).map((seed) => ({
    ...seed,
    id: seed.id ?? slugify(seed.title),
  }));
  return { seeds, pinnedGoalIds: seeds.filter((s) => s.pinned).map((s) => s.id) };
};

// Create whichever declared goals don't exist yet (idempotent on stable ids),
// then return the entity's live active+paused portfolio.
export const ensureSeededGoals = async (
  store: ProactivityStore,
  tickId: string,
  entityId: string,
  seeds: NormalizedSeeds["seeds"],
): Promise<GoalRecord[]> => {
  const missing = [];
  for (const seed of seeds) {
    if (!(await store.getGoal(seed.id))) missing.push(seed);
  }
  if (missing.length > 0) {
    await store.applyGoalMutations(
      tickId,
      missing.map((seed) => ({
        op: "create" as const,
        goalId: seed.id,
        title: seed.title,
        objective: seed.objective,
        doneCondition: seed.doneCondition,
        priority: seed.priority,
        reasoning: "Declared in proactivity config",
      })),
    );
  }
  return store.listGoals(entityId, { status: ["active", "paused"] });
};

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
