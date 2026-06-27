import type { GoalMutation } from "./types.js";

// Validates a batch of goal mutations from the (LLM) planner before they reach
// the store. Returns human-readable errors; empty array means the batch is clean.
export const validateGoalMutations = (mutations: GoalMutation[]): string[] => {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const m of mutations) {
    if (m.op !== "create" && !m.goalId) {
      errors.push(`${m.op} mutation missing goalId`);
    }

    if (m.goalId) {
      const key = `${m.goalId}:${m.op}`;
      if (seen.has(key)) {
        errors.push(`Duplicate ${m.op} for goal ${m.goalId}`);
      }
      seen.add(key);
    }

    if (m.op === "create" && !m.title) {
      errors.push("create mutation missing title");
    }

    if (m.goalId) {
      const hasCreate = mutations.some((o) => o.op === "create" && o.goalId === m.goalId);
      const hasArchive = mutations.some((o) => o.op === "archive" && o.goalId === m.goalId);
      if (hasCreate && hasArchive) {
        errors.push(`Cannot create and archive goal ${m.goalId} in the same batch`);
      }
    }
  }

  return errors;
};
