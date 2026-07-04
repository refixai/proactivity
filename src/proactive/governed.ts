// The universal governance mechanism the framework adapters build their
// governed() sugar on. Governance is opt-in per tool — wrap the tools that
// scare you; everything else runs untouched.
//
// Inside a wake (tick scope present): the side effect dispatches through the
// governance envelope — idempotency claimed BEFORE the effect runs (so a
// crash right after the send cannot double-fire on retry), caps checked,
// audit row written, and the outcome returned so the model can read
// "hard_denied: duplicate" and adapt in the same run.
//
// Outside a wake: transparent passthrough. The same agent keeps serving
// normal reactive traffic with zero behavior change.

import type { GovernanceOutcome } from "../core/types.js";
import { currentTickScope } from "./tickScope.js";

export type GovernedPerformRequest<T> = {
  // Names the action in the audit trail and the idempotency key.
  actionType: string;
  // Identifies WHAT the action lands on — the idempotency key is derived from
  // (actionType + target + tick), so two calls with the same target in one
  // wake collapse to one delivery. Choose the smallest set of fields that
  // identify the action: { userId }, not the whole message body.
  target: Record<string, unknown>;
  payload?: unknown;
  reasoning?: string;
  // Escalation past a triggered soft cap; see GovernanceOutcome.
  overrideReason?: string;
  perform: () => Promise<T>;
};

export type GovernedPerformResult<T> =
  | {
      // No tick scope — normal (non-proactive) execution, effect ran directly.
      governed: false;
      outcome: "ungoverned";
      result: T;
    }
  | {
      governed: true;
      outcome: GovernanceOutcome;
      // Present only when the effect actually ran (taken / soft_cap_overridden).
      result?: T;
      denialReason?: string;
      attemptId: string;
    };

export const governedPerform = async <T>(
  request: GovernedPerformRequest<T>,
): Promise<GovernedPerformResult<T>> => {
  const scope = currentTickScope();

  if (!scope) {
    return { governed: false, outcome: "ungoverned", result: await request.perform() };
  }

  // The dispatch's perform returns void; capture the tool's real return value
  // through the closure so a taken action can hand it back to the model.
  let result: T | undefined;
  const dispatch = await scope.governance.dispatch({
    goalId: scope.goalId,
    goalTickId: scope.goalTickId,
    actionType: request.actionType,
    target: request.target,
    payload: request.payload,
    reasoning: request.reasoning ?? `Agent called ${request.actionType}`,
    overrideReason: request.overrideReason,
    perform: async () => {
      result = await request.perform();
    },
  });

  const ran =
    dispatch.governanceOutcome === "taken" ||
    dispatch.governanceOutcome === "soft_cap_overridden";

  return {
    governed: true,
    outcome: dispatch.governanceOutcome,
    ...(ran ? { result: result as T } : {}),
    denialReason: dispatch.denialReason,
    attemptId: dispatch.attemptId,
  };
};

// The standard tool-result message for a governed call that didn't run — what
// the model reads in-band so it can re-plan instead of retrying blindly.
// Adapters return this as the tool's output on denial.
export const describeGovernanceOutcome = (
  outcome: GovernanceOutcome | "ungoverned",
  denialReason?: string,
): string => {
  switch (outcome) {
    case "taken":
    case "soft_cap_overridden":
    case "ungoverned":
      return "Action taken.";
    case "hard_denied":
      return `Action blocked by governance (hard_denied)${denialReason ? `: ${denialReason}` : ""}. Do not retry this action.`;
    case "soft_cap_denied":
      return `Action held by a soft cap (soft_cap_denied)${denialReason ? `: ${denialReason}` : ""}. Retry once with an overrideReason ONLY if the action is genuinely warranted.`;
    case "pending_approval":
      return "Action recorded and held for human approval (pending_approval). It has NOT run yet — do not retry.";
  }
};
