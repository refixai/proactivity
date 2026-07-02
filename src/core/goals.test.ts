import { describe, test, expect } from "vitest";
import { validateGoalMutations } from "./goals.js";

const portfolio = [
  { id: "g-active", status: "active" as const },
  { id: "g-paused", status: "paused" as const },
];

describe("validateGoalMutations", () => {
  test("non-create mutation without goalId is rejected", () => {
    const errors = validateGoalMutations([{ op: "archive", reasoning: "r" }]);
    expect(errors).toEqual(["archive mutation missing goalId"]);
  });

  test("create without title is rejected", () => {
    const errors = validateGoalMutations([{ op: "create", reasoning: "r" }]);
    expect(errors).toEqual(["create mutation missing title"]);
  });

  test("a goal can be mutated at most once per batch", () => {
    const errors = validateGoalMutations([
      { op: "update", goalId: "g-active", findings: "x", reasoning: "r" },
      { op: "complete", goalId: "g-active", reasoning: "r" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("more than one mutation");
  });

  test("create and archive of the same goal in one batch is rejected", () => {
    const errors = validateGoalMutations([
      { op: "create", goalId: "g-new", title: "T", reasoning: "r" },
      { op: "archive", goalId: "g-new", reasoning: "r" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("more than one mutation");
  });

  test("mutating a goal outside the portfolio is rejected (unknown or terminal)", () => {
    const errors = validateGoalMutations(
      [{ op: "update", goalId: "g-archived", findings: "x", reasoning: "r" }],
      portfolio,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not in the active portfolio");
  });

  test("pause requires an active goal", () => {
    const errors = validateGoalMutations(
      [{ op: "pause", goalId: "g-paused", reasoning: "r" }],
      portfolio,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("requires active");
  });

  test("update may resume a paused goal", () => {
    const errors = validateGoalMutations(
      [{ op: "update", goalId: "g-paused", status: "active", reasoning: "r" }],
      portfolio,
    );
    expect(errors).toEqual([]);
  });

  test("only update may set status", () => {
    const errors = validateGoalMutations(
      [{ op: "complete", goalId: "g-active", status: "active", reasoning: "r" }],
      portfolio,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot set status");
  });

  test("update cannot set a terminal status", () => {
    const errors = validateGoalMutations(
      [{ op: "update", goalId: "g-active", status: "completed" as never, reasoning: "r" }],
      portfolio,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("terminal states");
  });

  test("status-machine rules are skipped when no portfolio is provided", () => {
    const errors = validateGoalMutations([
      { op: "archive", goalId: "unknown-goal", reasoning: "r" },
    ]);
    expect(errors).toEqual([]);
  });

  test("clean batch passes", () => {
    const errors = validateGoalMutations(
      [
        { op: "create", title: "New mission", reasoning: "signal" },
        { op: "update", goalId: "g-active", findings: "learned x", reasoning: "r" },
        { op: "complete", goalId: "g-paused", reasoning: "done condition met" },
      ],
      portfolio,
    );
    expect(errors).toEqual([]);
  });
});
