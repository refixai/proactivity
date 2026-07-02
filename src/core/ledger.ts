import type { GovernanceOutcome } from "./types.js";

type LedgerEntry = {
  goalId: string;
  goalTickId: string;
  actionType: string;
  outcome: GovernanceOutcome;
};

export type Ledger = {
  record: (entry: LedgerEntry) => void;
  countActionsTaken: () => number;
  countActionsForPass: (goalTickId: string) => number;
};

// pending_approval counts as delivered so a dry-run tick produces the same
// action volume it would live — the caps bind identically and an operator
// reviews a representative set. Denied outcomes never consume cap budget.
const isDelivered = (outcome: GovernanceOutcome): boolean =>
  outcome === "taken" || outcome === "soft_cap_overridden" || outcome === "pending_approval";

export const createLedger = (): Ledger => {
  const entries: LedgerEntry[] = [];

  return {
    record: (entry) => {
      entries.push(entry);
    },

    countActionsTaken: () => entries.filter((e) => isDelivered(e.outcome)).length,

    countActionsForPass: (goalTickId) =>
      entries.filter((e) => e.goalTickId === goalTickId && isDelivered(e.outcome)).length,
  };
};
