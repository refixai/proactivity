// Types for the proactive() wrapper layer — the default door into the SDK.
// The design contract these types encode (see docs/implementation-philosophy.md):
// the developer's agent is a black box we brief before, observe during, and
// learn from after. Nothing here requires restructuring an existing agent.

import type {
  GoalPriority,
  GoalRecord,
  GovernanceOutcome,
  ProactivityStore,
  SchedulerAdapter,
  TickTrigger,
} from "../core/types.js";
import type { Duration } from "./duration.js";

// --- Transcript: what the adapter observed the agent do ---

// The normalized execution log reflection reads. Adapters map their framework's
// native trace (LangChain callbacks, Anthropic message threads, Eve self-report)
// into this shape. Deliberately compact: reflection needs the shape of what
// happened — which tools ran, with what, what came back, what the agent said —
// not every token of every intermediate prompt.
export type TranscriptEvent =
  | { type: "model"; content: string }
  | {
      type: "tool_call";
      name: string;
      args: unknown;
      result?: string;
      isError?: boolean;
    };

export type Transcript = {
  events: TranscriptEvent[];
  // The agent's final answer/message, when the framework has that concept.
  finalOutput: string | null;
};

// --- ReasoningModel: the developer's own LLM, behind a tiny interface ---

// Core has zero runtime dependencies, so it cannot hold a provider SDK or a
// model string. Reflection instead calls this interface; each adapter subpath
// ships a one-line helper that wraps the client the developer already has
// (anthropicModel(client, "..."), langchainModel(chatModel)). `schema` is a
// JSON Schema object — helpers enforce it provider-side where supported, and
// reflection re-validates defensively regardless.
export type ReasoningModel = {
  generate(prompt: string, schema: Record<string, unknown>): Promise<unknown>;
};

// --- Wake context: everything the developer may feed their agent ---

// One past wake, rendered for context. Assembled from the tick row, the
// goal-tick summary (reflection's ledger entry), and the attempt rows — the
// ledger is a composition of what the engine already writes, not a new table.
export type LedgerWake = {
  tickNumber: number;
  at: Date;
  trigger: TickTrigger;
  status: "running" | "completed" | "failed";
  // Reflection's one-paragraph account of the wake ("briefed 2 changed
  // tickets; still waiting on a reply from…"). Empty until reflection ran.
  summary: string;
  cadenceReasoning: string | null;
  actions: Array<{
    actionType: string;
    target: Record<string, unknown>;
    outcome: GovernanceOutcome;
  }>;
};

// Handed to the `input` callback (and embedded in the default situation
// report). This is the statefulness dial: the developer decides how much of
// it reaches their agent — all of it, some of it, or none (stateless).
export type WakeContext = {
  entityId: string;
  tickId: string;
  tickNumber: number;
  trigger: TickTrigger;
  now: Date;
  lastWakeAt: Date | null;
  // Active goals; `findings` is the goal's scratchpad (current state / open
  // threads / next steps), maintained by reflection every wake.
  goals: GoalRecord[];
  // Recent past wakes, most recent first.
  ledger: LedgerWake[];
  // The rendered situation report — what the agent receives by default when
  // no `input` callback is configured. Exposed so a custom callback can embed
  // it instead of rebuilding it.
  report: string;
};

// --- Adapter contract: how a framework plugs in ---

export type AgentRunInput<TCustom = unknown> = {
  context: WakeContext;
  // The default payload: the situation report, ready to hand to the agent as
  // a user message. Used when the developer supplied no `input` callback.
  message: string;
  // The `input` callback's output, when configured — adapter-specific shape
  // (a LangGraph state object, an Anthropic message list, …).
  custom?: TCustom;
};

// Deliberately small — three concerns, nothing else — which is what makes
// "works with all frameworks" realistic. run() executes the developer's
// UNCHANGED agent once and returns the normalized transcript.
export type ProactiveAgentAdapter<TCustom = unknown> = {
  // Shows up in errors and the ledger ("langgraph", "anthropic-loop", …).
  name: string;
  run(input: AgentRunInput<TCustom>): Promise<Transcript>;
};

// --- Config ---

// A developer-declared standing goal. Seeded idempotently on the first wake
// (stable ids make re-seeding a no-op across restarts). Pinned goals can't be
// completed/paused/archived by reflection — only their scratchpad evolves.
export type GoalSeed = {
  // Stable identifier; derived from the title when omitted.
  id?: string;
  title: string;
  objective: string;
  doneCondition: string;
  priority?: GoalPriority;
  pinned?: boolean;
};

// The wake gate: the ONLY pre-model code path, and its only legal question is
// "is it worth waking the model at all?" (cost control). It must never answer
// "here's what matters" — that judgment belongs to the agent. Return false to
// skip the wake; the tick is still recorded and cadence backs off.
export type GateContext = {
  entityId: string;
  now: Date;
  lastWakeAt: Date | null;
  goals: GoalRecord[];
};

export type ProactiveConfig<TCustom = unknown> = {
  // The developer's own LLM — powers reflection. Required: reflection is
  // always on, and this is the one parameter it needs.
  model: ReasoningModel;
  goals?: GoalSeed[];
  // Free-text guidance appended into the matching sections of the default
  // reflection prompt ("how to think about goals for this product: …").
  instructions?: {
    goals?: string;
    scheduling?: string;
    ledger?: string;
  };
  // Full prompt takeover for the rare case appending isn't enough. The output
  // schema stays enforced either way.
  prompts?: {
    reflect?: (ctx: ReflectPromptContext) => string;
  };
  cadence?: {
    min?: Duration;
    max?: Duration;
    // First wake after start(); defaults to min.
    default?: Duration;
  };
  // Defaults to the in-memory store — swap for createPostgresStore in prod.
  store?: ProactivityStore;
  // Defaults to the in-process timer adapter — swap for BullMQ in prod.
  schedule?: SchedulerAdapter;
  // Governance ceiling per wake, applied when any tools are governed().
  caps?: { perWake?: number };
  gate?: (ctx: GateContext) => boolean | Promise<boolean>;
  // The statefulness dial: shape exactly what reaches the agent each wake.
  // Omit it and the rendered situation report arrives as the user message.
  input?: (ctx: WakeContext) => TCustom;
  // How many past wakes the situation report includes. Default 5.
  ledgerWindow?: number;
  // Infra errors from background scheduled wakes (the tick itself records its
  // own failures via the store). Defaults to console.error.
  onError?: (error: unknown, entityId: string) => void;
};

// What a full-override reflect prompt receives — everything the default
// prompt builder uses.
export type ReflectPromptContext = {
  context: WakeContext;
  transcript: Transcript;
  goals: GoalRecord[];
  pinnedGoalIds: string[];
  cadence: { minMs: number; maxMs: number };
  instructions: NonNullable<ProactiveConfig["instructions"]>;
};

// --- Handle ---

export type ProactiveHandle = {
  // Begin the loop for an entity. One loop per entity; the first wake fires
  // after cadence.default.
  start(entityId: string): Promise<void>;
  // Halt the loop. Authoritative across replicas (flips `enabled` in the store).
  stop(entityId: string): Promise<void>;
  // Wake now — the webhook/event entry point. Does not resurrect a stopped
  // entity, and the wake's reflection re-arms the next scheduled one.
  wake(entityId: string): Promise<void>;
  // Re-arm every entity the store says should be running — call once after a
  // process restart when using a durable store.
  resume(): Promise<void>;
  // The store, exposed for power users (dashboards, custom queries). Same
  // engine the primitives use — ejecting is not a migration.
  store: ProactivityStore;
};
