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
  getEntries: () => ReadonlyArray<LedgerEntry>;
};

export const createLedger = (): Ledger => {
  const entries: LedgerEntry[] = [];

  return {
    record: (entry) => {
      entries.push(entry);
    },

    countActionsTaken: () =>
      entries.filter((e) => e.outcome === "taken" || e.outcome === "soft_cap_overridden").length,

    countActionsForPass: (goalTickId) =>
      entries.filter(
        (e) =>
          e.goalTickId === goalTickId &&
          (e.outcome === "taken" || e.outcome === "soft_cap_overridden"),
      ).length,

    getEntries: () => entries,
  };
};
