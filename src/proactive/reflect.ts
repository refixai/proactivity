// Reflection: the post-run reasoning step, always on, powered by the
// developer's own model.
//
// After the agent runs, one structured-output call reads the transcript and
// decides what the wake MEANT: the ledger entry future wakes will read, how
// each goal's scratchpad evolves, and when to wake next. Keeping this
// post-hoc — instead of demanding the agent's own prompt manage goals and
// cadence — is what lets the agent stay an unmodified black box, and it's
// deliberately better placed: reflection sees what actually happened, not
// what the agent intended.
//
// The model output is treated as hostile input: schema enforced provider-side
// where supported, re-validated here regardless, pinned goals shielded, and
// the cadence clamped to configured bounds. A malformed reflection degrades
// (defaults + a warning in the ledger entry) rather than failing the wake —
// the agent's work already happened; bookkeeping must not undo it.

import { validateGoalMutations } from "../core/goals.js";
import type { GoalMutation, GoalPriority, GoalRecord } from "../core/types.js";
import type {
  ReasoningModel,
  ReflectPromptContext,
  Transcript,
} from "./types.js";

export type ReflectOutput = {
  ledgerEntry: string;
  goalMutations: GoalMutation[];
  nextWakeMinutes: number;
  nextWakeReasoning: string;
  // Anything dropped during validation, surfaced instead of silently eaten.
  warnings: string[];
};

// --- Output schema (JSON Schema, provider-enforced where supported) ---

const GOAL_MUTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["op", "reasoning"],
  properties: {
    op: {
      type: "string",
      enum: ["create", "update", "reprioritize", "pause", "complete", "archive"],
    },
    goalId: { type: "string", description: "Required for every op except create." },
    title: { type: "string" },
    objective: { type: "string" },
    doneCondition: { type: "string" },
    findings: {
      type: "string",
      description:
        "The goal's full replacement scratchpad: current state, open threads (what you're waiting on, since when), next steps.",
    },
    nextActions: { type: "string" },
    priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
    status: {
      type: "string",
      enum: ["active", "paused"],
      description: "update only — the resume/pause path. Terminal states go through complete/archive.",
    },
    reasoning: { type: "string" },
  },
} as const;

export const REFLECT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ledgerEntry", "goalMutations", "nextWakeMinutes", "nextWakeReasoning"],
  properties: {
    ledgerEntry: {
      type: "string",
      description:
        "One tight paragraph: what happened this wake and why it matters. Future wakes read this — write for your future self.",
    },
    goalMutations: { type: "array", items: GOAL_MUTATION_SCHEMA },
    nextWakeMinutes: {
      type: "number",
      description: "Minutes until the next wake. Will be clamped to the configured cadence bounds.",
    },
    nextWakeReasoning: {
      type: "string",
      description: "Why that interval — what are you waiting for?",
    },
  },
} as const;

// --- Transcript rendering (compact, bounded) ---

const TOOL_RESULT_LIMIT = 1_500;
const MODEL_TEXT_LIMIT = 2_000;
const TRANSCRIPT_CHAR_BUDGET = 24_000;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;

// No silent truncation: when the budget cuts events, the rendering says so.
export const renderTranscript = (transcript: Transcript): string => {
  const lines: string[] = [];
  for (const event of transcript.events) {
    if (event.type === "model") {
      lines.push(`[agent] ${truncate(event.content, MODEL_TEXT_LIMIT)}`);
    } else {
      const args = truncate(safeStringify(event.args), 600);
      const result =
        event.result === undefined
          ? ""
          : ` → ${event.isError ? "ERROR: " : ""}${truncate(event.result, TOOL_RESULT_LIMIT)}`;
      lines.push(`[tool] ${event.name}(${args})${result}`);
    }
  }
  if (transcript.finalOutput) {
    lines.push(`[final] ${truncate(transcript.finalOutput, MODEL_TEXT_LIMIT)}`);
  }
  if (lines.length === 0) return "(the agent produced no observable events this wake)";

  let rendered = lines.join("\n");
  if (rendered.length > TRANSCRIPT_CHAR_BUDGET) {
    // Keep the tail — the end of a run (final actions, final answer) carries
    // more reflection signal than the opening context dump.
    const dropped = rendered.length - TRANSCRIPT_CHAR_BUDGET;
    rendered = `[transcript head truncated: ${dropped} chars dropped]\n…${rendered.slice(-TRANSCRIPT_CHAR_BUDGET)}`;
  }
  return rendered;
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

// --- The default prompt ---

const formatGoals = (goals: GoalRecord[], pinnedGoalIds: string[]): string => {
  if (goals.length === 0) return "(no goals yet)";
  const pinned = new Set(pinnedGoalIds);
  return goals
    .map((g) => {
      const tag = pinned.has(g.id) ? " [PINNED — never complete/pause/archive]" : "";
      const scratchpad = g.findings ? `\n  scratchpad: ${g.findings}` : "";
      return `- ${g.id} [${g.status}/${g.priority}] ${g.title}: ${g.objective} (done when: ${g.doneCondition})${tag}${scratchpad}`;
    })
    .join("\n");
};

export const buildReflectPrompt = (ctx: ReflectPromptContext): string => {
  const { context, transcript, goals, pinnedGoalIds, cadence, instructions } = ctx;
  const minMinutes = Math.max(1, Math.round(cadence.minMs / 60_000));
  const maxMinutes = Math.max(minMinutes, Math.round(cadence.maxMs / 60_000));

  return `# Reflection

You are the reflection step of a proactive agent runtime. The agent for entity "${context.entityId}" just finished wake #${context.tickNumber}. Your job is bookkeeping and pacing — NOT re-doing the agent's work: write the ledger entry, evolve the goal portfolio, and decide when to wake next.

## The goal portfolio (before this wake)
${formatGoals(goals, pinnedGoalIds)}

## What the agent did this wake (full transcript)
${renderTranscript(transcript)}

## How to think about the ledger entry
Write one tight paragraph your future self will rely on: what was observed, what was done (or deliberately not done), and anything in flight. Be concrete — names, identifiers, timestamps beat vibes. A quiet wake with a clear reason is a good entry.${instructions.ledger ? `\n\nProduct-specific guidance: ${instructions.ledger}` : ""}

## How to think about goals
Each goal's \`findings\` is its scratchpad — you own it. Rewrite it (full replacement, not a diff) with three sections: current state; open threads (what you're waiting on and since when); next steps. Update a goal only when this wake actually taught you something. Create a goal only for a real mission worth pursuing across wakes; complete/archive boldly when done or stale — a zombie goal is worse than a missing one. Goals marked PINNED are standing missions: update their scratchpad freely, never complete/pause/archive them.${instructions.goals ? `\n\nProduct-specific guidance: ${instructions.goals}` : ""}

## How to think about the next wake
Pick nextWakeMinutes between ${minMinutes} and ${maxMinutes} (values outside are clamped). Match the interval to what you're actually waiting for: your own follow-through → short; an external system that changes hourly → medium; a human reply → long. Activity this wake usually means look again sooner; a quiet wake means back off.${instructions.scheduling ? `\n\nProduct-specific guidance: ${instructions.scheduling}` : ""}

Respond with JSON matching the provided schema.`;
};

// --- Defensive parsing ---

const GOAL_OPS = new Set(["create", "update", "reprioritize", "pause", "complete", "archive"]);
const PRIORITIES = new Set<GoalPriority>(["low", "medium", "high", "critical"]);

const asOptionalString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

// Model output → ReflectOutput. Invalid pieces are dropped with a warning,
// never thrown: the agent's work already happened, and bookkeeping must not
// turn a completed wake into a failed one.
export const parseReflectOutput = (
  raw: unknown,
  opts: {
    goals: GoalRecord[];
    pinnedGoalIds: string[];
    cadence: { minMs: number; maxMs: number };
  },
): ReflectOutput => {
  const warnings: string[] = [];
  const fallbackMinutes = Math.round(opts.cadence.maxMs / 60_000);
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") {
    warnings.push("reflection output was not an object; using defaults");
  }

  const ledgerEntry =
    typeof obj.ledgerEntry === "string" && obj.ledgerEntry.trim()
      ? obj.ledgerEntry.trim()
      : (warnings.push("reflection produced no ledgerEntry"), "(reflection produced no ledger entry)");

  // nextWake: clamp, don't trust.
  let nextWakeMinutes =
    typeof obj.nextWakeMinutes === "number" && Number.isFinite(obj.nextWakeMinutes)
      ? obj.nextWakeMinutes
      : (warnings.push("reflection produced no usable nextWakeMinutes; backing off to cadence max"),
        fallbackMinutes);
  const minMinutes = opts.cadence.minMs / 60_000;
  const maxMinutes = opts.cadence.maxMs / 60_000;
  nextWakeMinutes = Math.min(Math.max(nextWakeMinutes, minMinutes), maxMinutes);

  const nextWakeReasoning =
    asOptionalString(obj.nextWakeReasoning)?.trim() || "(no reasoning given)";

  // Goal mutations: shape-check each, shield pinned goals, then run the
  // batch through the same validator the primitives use.
  const pinned = new Set(opts.pinnedGoalIds);
  const mutations: GoalMutation[] = [];
  const rawMutations = Array.isArray(obj.goalMutations) ? obj.goalMutations : [];

  for (const entry of rawMutations) {
    if (!entry || typeof entry !== "object") {
      warnings.push("dropped non-object goal mutation");
      continue;
    }
    const m = entry as Record<string, unknown>;
    const op = m.op;
    if (typeof op !== "string" || !GOAL_OPS.has(op)) {
      warnings.push(`dropped goal mutation with unknown op "${String(m.op)}"`);
      continue;
    }
    const goalId = asOptionalString(m.goalId);
    if (goalId && pinned.has(goalId) && op !== "update" && op !== "reprioritize") {
      warnings.push(`dropped ${op} on pinned goal ${goalId}`);
      continue;
    }

    const mutation: GoalMutation = {
      op: op as GoalMutation["op"],
      reasoning: asOptionalString(m.reasoning)?.trim() || "(no reasoning given)",
    };
    if (goalId) mutation.goalId = goalId;
    const title = asOptionalString(m.title);
    if (title !== undefined) mutation.title = title;
    const objective = asOptionalString(m.objective);
    if (objective !== undefined) mutation.objective = objective;
    const doneCondition = asOptionalString(m.doneCondition);
    if (doneCondition !== undefined) mutation.doneCondition = doneCondition;
    const findings = asOptionalString(m.findings);
    if (findings !== undefined) mutation.findings = findings;
    const nextActions = asOptionalString(m.nextActions);
    if (nextActions !== undefined) mutation.nextActions = nextActions;
    if (typeof m.priority === "string" && PRIORITIES.has(m.priority as GoalPriority)) {
      mutation.priority = m.priority as GoalPriority;
    }
    if (m.status === "active" || m.status === "paused") {
      if (goalId && pinned.has(goalId)) {
        warnings.push(`stripped status change on pinned goal ${goalId}`);
      } else {
        mutation.status = m.status;
      }
    }
    mutations.push(mutation);
  }

  // Validate each mutation on its own (status machine, unknown/terminal
  // goals) so one bad mutation drops alone instead of poisoning the batch,
  // then validate the surviving batch once more for the cross-mutation rules
  // (duplicate goal targets). If the batch is somehow still dirty, refuse it
  // whole rather than apply a half-validated one.
  let accepted: GoalMutation[] = [];
  for (const mutation of mutations) {
    const errors = validateGoalMutations([mutation], opts.goals);
    if (errors.length > 0) {
      warnings.push(...errors.map((e) => `dropped by validator: ${e}`));
      continue;
    }
    accepted.push(mutation);
  }
  const batchErrors = validateGoalMutations(accepted, opts.goals);
  if (batchErrors.length > 0) {
    warnings.push(`goal mutation batch rejected entirely: ${batchErrors.join("; ")}`);
    accepted = [];
  }

  return { ledgerEntry, goalMutations: accepted, nextWakeMinutes, nextWakeReasoning, warnings };
};

// --- The full step ---

export const runReflection = async (opts: {
  model: ReasoningModel;
  promptContext: ReflectPromptContext;
  promptOverride?: (ctx: ReflectPromptContext) => string;
}): Promise<ReflectOutput> => {
  const prompt = (opts.promptOverride ?? buildReflectPrompt)(opts.promptContext);

  let raw: unknown;
  try {
    raw = await opts.model.generate(prompt, REFLECT_OUTPUT_SCHEMA as unknown as Record<string, unknown>);
  } catch (err) {
    // Reflection failing must not fail the wake — degrade to defaults and
    // record why, so the gap is visible in the ledger instead of silent.
    const message = err instanceof Error ? err.message : String(err);
    return parseReflectOutput(
      { ledgerEntry: `(reflection model call failed: ${message})` },
      {
        goals: opts.promptContext.goals,
        pinnedGoalIds: opts.promptContext.pinnedGoalIds,
        cadence: opts.promptContext.cadence,
      },
    );
  }

  // Some providers hand structured output back as a JSON string.
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      // leave as-is; parseReflectOutput will default it with a warning
    }
  }

  return parseReflectOutput(raw, {
    goals: opts.promptContext.goals,
    pinnedGoalIds: opts.promptContext.pinnedGoalIds,
    cadence: opts.promptContext.cadence,
  });
};
