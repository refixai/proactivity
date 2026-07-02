import type { GoalMutation, GoalRecord } from "./types.js";

// Validates a batch of goal mutations from the (LLM) planner before they reach
// the store. When `portfolio` is provided (the entity's active + paused goals),
// the goal status machine is enforced too: non-create ops must target a
// portfolio goal — terminal (completed/archived) and unknown goals are
// immutable — and pause requires active. Returns human-readable errors; empty
// array means the batch is clean.
export const validateGoalMutations = (
  mutations: GoalMutation[],
  portfolio?: Pick<GoalRecord, "id" | "status">[],
): string[] => {
  const errors: string[] = [];
  const seen = new Set<string>();
  const statusById = portfolio && new Map(portfolio.map((g) => [g.id, g.status]));

  for (const m of mutations) {
    if (m.op !== "create" && !m.goalId) {
      errors.push(`${m.op} mutation missing goalId`);
      continue;
    }

    if (m.op === "create" && !m.title) {
      errors.push("create mutation missing title");
    }

    if (m.status !== undefined && m.op !== "update") {
      errors.push(`${m.op} mutation cannot set status; only update may (active/paused)`);
    }
    if (m.op === "update" && m.status !== undefined && m.status !== "active" && m.status !== "paused") {
      errors.push(
        `update status must be "active" or "paused"; terminal states are reached via complete/archive`,
      );
    }

    if (m.goalId) {
      if (seen.has(m.goalId)) {
        errors.push(`goal ${m.goalId} appears in more than one mutation; at most one per batch`);
      }
      seen.add(m.goalId);
    }

    if (statusById && m.op !== "create" && m.goalId) {
      const status = statusById.get(m.goalId);
      if (status === undefined) {
        errors.push(
          `${m.op} targets goal ${m.goalId}, which is not in the active portfolio (unknown or terminal)`,
        );
      } else if (m.op === "pause" && status !== "active") {
        errors.push(`pause on goal ${m.goalId} requires active; current status is ${status}`);
      }
    }
  }

  return errors;
};
