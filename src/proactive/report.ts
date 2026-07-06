// The situation report: what the agent receives when it wakes.
//
// This is the inject step. It is assembled entirely from what the store
// already knows — goals + scratchpads, recent ledger, clock facts — and it
// deliberately contains NO judgment about what matters. Deciding what's
// noteworthy is the agent's job; the report's job is to make the agent's
// past self available to its present self.

import type { ProactivityStore, TickRecord } from "../core/types.js";
import type { LedgerWake, WakeContext } from "./types.js";

const formatAgo = (from: Date, to: Date): string => {
  const ms = Math.max(0, to.getTime() - from.getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

// Tick rows → rendered ledger wakes (summary from the goal-tick, actions from
// the audit trail). Shared by the report window and ledger compaction.
export const loadWakesForTicks = (
  store: ProactivityStore,
  ticks: TickRecord[],
): Promise<LedgerWake[]> =>
  Promise.all(
    ticks.map(async (tick) => {
      const [goalTicks, attempts] = await Promise.all([
        store.listGoalTicks(tick.id),
        store.listAttempts(tick.id),
      ]);
      return {
        tickNumber: tick.tickNumber,
        at: tick.startedAt,
        trigger: tick.trigger,
        status: tick.status === "running" ? ("running" as const) : tick.status,
        summary: goalTicks.map((gt) => gt.summary).filter(Boolean).join(" | "),
        cadenceReasoning: tick.cadenceReasoning,
        actions: attempts.map((a) => ({
          actionType: a.actionType,
          target: a.target,
          outcome: a.governanceOutcome,
        })),
      };
    }),
  );

// Ledger view of past wakes, most recent first. The current (running) tick is
// excluded — it has no story yet.
export const loadLedger = async (
  store: ProactivityStore,
  entityId: string,
  currentTickId: string,
  window: number,
): Promise<LedgerWake[]> => {
  const ticks = (await store.listRecentTicks(entityId, { limit: window + 1 })).filter(
    (t) => t.id !== currentTickId,
  );
  return loadWakesForTicks(store, ticks.slice(0, window));
};

// One past wake as markdown lines — the same shape the report shows, reused
// by ledger compaction so the summarizer reads what the agent would have.
export const renderWake = (wake: LedgerWake): string[] => {
  const lines = [
    `### Wake #${wake.tickNumber} — ${wake.at.toISOString()} (${wake.status}${wake.trigger === "manual" ? ", manual" : ""})`,
    wake.summary || "(no summary recorded)",
  ];
  for (const action of wake.actions) {
    lines.push(`- ${action.actionType} ${safeStringify(action.target)} → ${action.outcome}`);
  }
  if (wake.cadenceReasoning) lines.push(`- next-wake reasoning: ${wake.cadenceReasoning}`);
  return lines;
};

export const renderReport = (ctx: Omit<WakeContext, "report">): string => {
  const lines: string[] = [];

  lines.push(`# Situation report — wake #${ctx.tickNumber} for "${ctx.entityId}"`);
  lines.push("");
  lines.push(`- Now: ${ctx.now.toISOString()}`);
  lines.push(
    ctx.lastWakeAt
      ? `- Last wake: ${ctx.lastWakeAt.toISOString()} (${formatAgo(ctx.lastWakeAt, ctx.now)} ago)`
      : "- This is your first wake — there is no history yet.",
  );
  if (ctx.trigger === "manual") {
    lines.push("- This wake was triggered manually (likely an external event), not by the schedule.");
  }
  lines.push("");

  lines.push("## Standing goals");
  if (ctx.goals.length === 0) {
    lines.push("(none)");
  } else {
    for (const goal of ctx.goals) {
      lines.push(`- [${goal.status}/${goal.priority}] ${goal.title} — ${goal.objective} (done when: ${goal.doneCondition})`);
      if (goal.findings) lines.push(`  scratchpad: ${goal.findings}`);
    }
  }
  lines.push("");

  lines.push("## Recent wakes (most recent first)");
  if (ctx.ledger.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const wake of ctx.ledger) {
      lines.push(...renderWake(wake));
      lines.push("");
    }
  }

  if (ctx.ledgerSummary) {
    lines.push("## Older wakes (rolling summary)");
    lines.push(ctx.ledgerSummary);
    lines.push("");
  }

  lines.push("## How to proceed");
  lines.push(
    "You woke up on your own initiative. Review the situation with your tools and decide what — if anything — deserves action. " +
      "Acting is optional: a wake where you deliberately do nothing is a good wake if nothing warranted attention. " +
      "Never repeat an action the ledger already shows as taken unless something genuinely changed.",
  );

  return lines.join("\n");
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
