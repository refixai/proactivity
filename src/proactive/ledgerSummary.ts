// Ledger compaction — the long-term memory behind report.summarizeOlderWakes.
//
// The report shows the last N wakes verbatim; everything older would simply
// fall off the agent's world. With compaction on, each completed wake folds
// the wakes that just aged out of the window into one rolling summary
// (maintained by the reflection model), so wake #500 still knows what wake #3
// promised. The fold is incremental and resumable: `ledgerSummaryThroughTick`
// marks how far the summary reaches, a batch cap bounds any single fold (a
// long backlog catches up over a few wakes), and a failed fold simply leaves
// the marker where it was — next wake retries.

import type { ProactivityStore } from "../core/types.js";
import { loadWakesForTicks, renderWake } from "./report.js";
import type { LedgerWake, ReasoningModel } from "./types.js";

// Bound on wakes folded per tick: enabling compaction on an old entity
// catches up gradually instead of stuffing its whole history into one prompt.
const FOLD_BATCH_LIMIT = 25;
// Defensive ceiling on the stored summary — memory, not a log.
const SUMMARY_CHAR_LIMIT = 4_000;

export const LEDGER_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: {
      type: "string",
      description:
        "The updated rolling summary — long-term memory, not a log. Keep identifiers, dates, unresolved threads, commitments, durable facts; drop play-by-play.",
    },
  },
} as const;

export const buildLedgerSummaryPrompt = (opts: {
  entityId: string;
  currentSummary: string | null;
  throughTick: number;
  wakes: LedgerWake[];
}): string => {
  const wakeBlocks = opts.wakes.map((wake) => renderWake(wake).join("\n")).join("\n\n");
  return `# Ledger compaction

You maintain the long-term memory of a proactive agent for entity "${opts.entityId}". The agent sees its recent wakes verbatim; older wakes live only in the rolling summary below. Fold the newly aged-out wakes into it.

Rules:
- Under 300 words. This is memory, not a log: keep identifiers, dates, unresolved threads, commitments, and durable facts; drop play-by-play.
- Newer information wins on conflict.
- If the current summary is empty, start one.

## Current rolling summary${opts.throughTick > 0 ? ` (covers through wake #${opts.throughTick})` : ""}
${opts.currentSummary?.trim() || "(none yet)"}

## Newly aged-out wakes to fold in (oldest first)
${wakeBlocks}

Respond with JSON matching the provided schema.`;
};

// Fold everything that aged out of the recent window as of the wake that just
// completed. One model call when there is work; a no-op otherwise. Throws on
// a failed/unusable model response — the caller decides how loudly to log,
// and the unadvanced marker makes the next wake retry.
export const foldOlderWakes = async (opts: {
  store: ProactivityStore;
  model: ReasoningModel;
  entityId: string;
  // The tick that just completed — wakes at or below (this - recentWakes)
  // are no longer visible in the next report.
  completedTickNumber: number;
  recentWakes: number;
}): Promise<void> => {
  const { store, model, entityId } = opts;
  const cutoff = opts.completedTickNumber - opts.recentWakes;
  if (cutoff <= 0) return;

  const state = await store.getState(entityId);
  const through = state?.ledgerSummaryThroughTick ?? 0;
  if (cutoff <= through) return;

  const ticks = await store.listTicksInRange(entityId, {
    afterTick: through,
    throughTick: cutoff,
    limit: FOLD_BATCH_LIMIT,
  });
  if (ticks.length === 0) {
    // Nothing recorded in the gap (shouldn't happen — tick numbers are
    // contiguous) — advance the marker so we don't re-scan it forever.
    await store.upsertState(entityId, { ledgerSummaryThroughTick: cutoff });
    return;
  }

  const wakes = await loadWakesForTicks(store, ticks);
  const prompt = buildLedgerSummaryPrompt({
    entityId,
    currentSummary: state?.ledgerSummary ?? null,
    throughTick: through,
    wakes,
  });

  const raw = await model.generate(prompt, LEDGER_SUMMARY_SCHEMA as unknown as Record<string, unknown>);
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  const summary =
    parsed && typeof parsed === "object" && typeof (parsed as { summary?: unknown }).summary === "string"
      ? ((parsed as { summary: string }).summary.trim() || null)
      : null;
  if (!summary) {
    throw new Error("ledger summary: model returned no usable summary — keeping the previous one");
  }

  await store.upsertState(entityId, {
    ledgerSummary: summary.slice(0, SUMMARY_CHAR_LIMIT),
    // The highest tick actually folded — with a capped batch this can trail
    // the cutoff; the next wake folds the rest.
    ledgerSummaryThroughTick: ticks[ticks.length - 1]!.tickNumber,
  });
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
