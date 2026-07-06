# Implementation philosophy: `proactive()`

This is the reference for how the wrapper layer gets built. The *why* lives in
[proactive-wrapper-argument.md](./proactive-wrapper-argument.md); this document
records the decisions and the architecture they imply. Everything here was
settled deliberately — if an implementation detail contradicts this doc, the
doc wins until it's explicitly revised.

## The one-sentence product

A proactive agent is a normal agent plus someone who wakes it at the right
time, hands it the right context, and stops it from overdoing it. `proactive()`
is that someone. The developer's agent does not have to change to become
proactive — and how *aware* it is of its own proactivity is the developer's
choice, not ours.

## Non-negotiables

1. **One release, all three frameworks.** No v1/v2 staging. LangGraph, the raw
   Anthropic SDK, and Eve ship together. The acceptance bar: an existing agent
   becomes proactive in ~10 lines.
2. **The primitives do not change.** Store schema, scheduler, heartbeat,
   governance, goal machine, mutation validation — untouched. The wrapper is
   built *from* them (`proactive()` compiles down to `createHeartbeat` +
   `createScheduler` + `createGovernance` + a store). Additions are allowed
   (new store read methods, new modules); breaking changes are not. Primitives
   stay public as the power-user door — ejecting from the wrapper is not a
   migration, because it's the same engine underneath.
3. **The agent is a black box we brief, observe, and learn from.** We never
   require restructuring it. We inject context before, capture the transcript
   during, reflect after.
4. **Judgment lives in models, not in TypeScript.** No user-authored "what
   matters" filters in the happy path. "What's new" is a fact; "what matters"
   is a judgment. Anywhere the design tempts a developer to hand-code
   relevance, the design is wrong.

## The wake pipeline

Every wake runs the same four moments, all orchestrated by the wrapper on top
of the existing heartbeat:

```
scheduler fires (or .wake() is called — webhooks/events enter here)
│
├─ INJECT   render the situation report from the store: active goals + their
│           scratchpads, recent ledger (past wakes, actions taken), time since
│           last wake. Hand it to the agent — by default as a user message;
│           via the `input` callback if the dev wants to shape it.
│
├─ RUN      adapter.run(...) executes the dev's UNCHANGED agent inside an
│           AsyncLocalStorage tick context. Tools wrapped with governed()
│           dispatch through the governance envelope; everything else runs
│           exactly as it always did. The adapter records the full transcript.
│
├─ REFLECT  one structured-output call on the DEV'S model over the transcript:
│           { ledgerEntry, goalMutations, nextWakeMinutes, nextWakeReasoning }.
│           Validated, clamped to cadence bounds, applied through the existing
│           goal machine. Always on — never optional.
│
└─ SCHEDULE the existing scheduler re-enqueues at the reflected cadence.
```

This is Oracle's heartbeat generalized — hydration → inject, strategist →
reflect, executor → the dev's agent. One deliberate inversion: Oracle plans
*before* acting; the wrapper reflects *after*. We don't control the dev's
agent, so we can't make it follow a plan — we can only brief it before and
learn from it after. Post-hoc is the only placement that works for arbitrary
agents.

## Decisions, with reasoning

### Reflection is always required

Reflection runs on the developer's own model, passed once as config. Since
that parameter is required anyway, always-on reflection adds zero setup — and
it's what makes the ledger trustworthy: every wake gets a reflected entry, no
gaps. Reflection is also deliberately *post-hoc goal management*: it keeps goal
mutations out of the agent's own prompt, so the agent stays focused on its
task and the portfolio bookkeeping happens where it can't pollute task
reasoning.

### The developer's LLM, via a tiny interface

Core stays dependency-free, so it cannot accept a model string or a framework
object. Core defines:

```ts
type ReasoningModel = {
  generate(prompt: string, schema: object): Promise<unknown>;
};
```

Each adapter subpath ships a one-line helper for its ecosystem —
`anthropicModel(client, "claude-sonnet-5")`, `langchainModel(chatModel)` — so
the dev hands us the client they already have. Structured output is enforced
inside the helper (Anthropic `output_config` json_schema; LangChain
`withStructuredOutput`), and defensively re-validated in core regardless.

### Prompts: opinionated defaults, two override layers

- **Append (common):** `reflection.instructions: { goals?, scheduling?, ledger? }`
  — free-text snippets injected into the matching sections of the default
  reflection prompt ("how to think about goals for this product: …").
- **Replace (rare):** `reflection.prompt: (ctx) => string` — full takeover.
  The output schema stays enforced either way.

### Governance is opt-in, per tool

Context-based restraint is the default posture: the ledger in the situation
report means the model *usually* won't repeat itself, and that costs nothing.
Enforcement is opt-in — wrap the tools that scare you:

```ts
const sendBrief = governed(tool(...), { target: (args) => ({ userId: args.userId }) });
```

Why enforcement survives even though reasoning usually suffices — three things
reasoning cannot do:

1. **Crash-safe dedupe.** Governance claims the idempotency key *before*
   performing (insert attempt → perform → mark complete). If the process dies
   right after the send, the claimed key blocks the re-run. The ledger is
   written at reflection — *after* the wake — so a crash in between would
   otherwise mean a duplicate the next wake can't know about.
2. **Mid-run correction.** A denial returns *as the tool result* — the model
   reads `hard_denied: duplicate` and adapts inside the same run. Pure
   reasoning has no backstop mid-run; it *is* the thing being backstopped.
3. **Audit requires interception anyway.** You can't write an attempt row for
   an action you never observed. Once intercepting for audit, idempotency and
   caps are marginal — and "restraint as a database constraint, not a prompt"
   is the product's strongest sentence.

Mechanics: `governed()` reads the ambient tick context from AsyncLocalStorage.
Inside a wake → dispatch through the envelope (returning the tool's real
result when taken, the outcome message when denied). Outside a wake (normal
reactive use of the same agent) → transparent passthrough. Prism validates the
split: Oracle governs its five action tools and leaves every investigative
tool free.

### Goals: pinned + evolving, scratchpad per goal, threads as convention

- Developer-declared goals in config can be **pinned**: reflection updates
  their scratchpad but cannot close them. Evolution on top: reflection may
  open/close its own goals through the existing mutation ops, validated by the
  existing `validateGoalMutations`.
- **Scratchpad per goal** is the memory unit. It is the existing
  `GoalRecord.findings` column surfaced as `scratchpad` in the wrapper API —
  no schema change. Reflection maintains it every wake.
- **Threads are a prompt convention, not an entity.** The default reflection
  prompt tells the model to keep a structured scratchpad: *current state /
  open threads (what we're waiting on, since when) / next steps*. Prism proved
  this: Oracle has no threads table — its "open threads" live in charter
  findings plus the action-attempt trail (continuity matches replies against
  attempt target coordinates). Threads-as-entity is complexity with no payer.
  If someone needs prism-style reply routing, the attempts ledger already
  stores targets; that's a documented recipe, not schema.

### The ledger

The session ledger is not a new table. It is the composition of what the
engine already writes — tick rows (status, counts, cadence reasoning), the
per-wake goal-tick summary (reflection's `ledgerEntry` lands here), and the
attempt rows (every governed action with outcome). The situation report
renders from these; the store grows two additive read methods
(`listRecentTicks`, `listGoalTicks`) so the report can look back.

### Statefulness is the developer's dial

The wake context callback exposes everything — `{ goals, scratchpads, ledger,
lastReflection, history, now, entityId, report }` — and the developer decides
how much reaches their agent. Omit the callback and the rendered situation
report arrives as the user message (stateful by default). Provide `input` and
you control exactly what flows in, down to ignoring all of it (stateless).

### Observability is the SDK's job, loud by default

The wrapper already sees everything — it records the transcript, dispatches
governance, runs reflection — so making the developer hand-roll callbacks just
to watch their own loop would be selling the observation machinery twice.
`observe` on the config takes the whole story as one flat event stream
(`wake_started → agent_event* → governance* → reflection → wake_completed`,
plus `wake_skipped`/`wake_failed`), with agent events forwarded live by the
adapters as they record. The default is a compact console narrator: a
background agent's worst failure mode is silence, so the out-of-box experience
is watching the loop breathe. Pass a function to route into a real logger,
`false` to silence. Observers are telemetry — one that throws is swallowed,
never allowed to fail a wake.

### Sensing belongs to the agent; the wake gate is the only pre-model code

No briefing sources in the happy path. The agent senses with its own read
tools, judged by its own model, informed by the scratchpad. The single
legitimate pre-model hook is the optional wake gate —
`shouldWake: (ctx) => boolean` — whose only legal question is "is it worth
waking the model at all?" (cost control), never "here is what matters."

## Transcript capture, per framework

Reflection needs the full execution log — every model call, every tool call,
across subgraphs. How we get it differs per framework; each adapter normalizes
into one compact `Transcript` (tool calls with truncated results, model turns,
final output — reflection needs the shape of what happened, not every token).

- **LangGraph — the callbacks system.** Pass `{ callbacks: [recorder] }` into
  `graph.invoke()`. LangChain callbacks are inheritable: the handler receives
  every event from every child runnable — every node, every nested subgraph,
  every model and tool call — with runId/parentRunId forming the run tree.
  This is the same mechanism LangSmith uses; we are an in-process mini-tracer.
  Works on arbitrary graphs, zero changes to the dev's code.
- **Anthropic SDK — the traced client.** The Messages API is stateless, so the
  full history *is* the messages array by construction. Two shapes: our
  loop-runner (`runLoop({ client, tools, system })` — we own the loop,
  transcript natively ours), or BYO loop (`fromAnthropic({ client, run })` —
  the dev's `run` receives a proxied client; every `messages.create`
  request/response through it is recorded; their loop code doesn't change).
- **Eve — eve-native, structurally different, honestly so.** Eve is a durable
  workflow runtime that owns sessions and scheduling. The integration follows
  Eve's grain: Eve cron triggers wakes; session hooks open the tick and seed
  serialized ids into `defineState` (live handles don't survive step
  boundaries — the proven rebuild-from-ids pattern from `examples/eve`);
  reflection runs at session end and programs the next Eve wake. Whatever
  transcript access Eve exposes, we use; where only an agent self-report is
  available, we say so in the docs rather than pretend.

## API surface (the whole thing)

```ts
import { proactive, memoryStore } from "@refix/proactivity";
import { fromLangGraph, governed, langchainModel } from "@refix/proactivity/langgraph";

const handle = proactive(fromLangGraph(agent), {
  reflection: {
    model: langchainModel(llm),                    // required — the SDK's own reasoning step
    instructions: { goals: "…", scheduling: "…" }, // appended to the default prompt
    // prompt: (ctx) => string                     // full prompt takeover (schema still enforced)
  },
  goals: [{ title, objective, doneCondition, pinned: true }],
  cadence: { min: "15m", max: "24h" },
  store: memoryStore(),                            // postgres(url) in prod
  governance: { maxActionsPerWake: 10 },           // ceiling, if any tools are governed
  shouldWake: async (ctx) => true,                 // optional wake gate (cost control only)
  agentInput: (ctx) => ({ messages: [...] }),      // optional statefulness dial
  report: { recentWakes: 5 },                      // wakes shown verbatim in the report
});

await handle.start(entityId);   // one loop per entity
await handle.wake(entityId);    // manual/webhook-triggered wake
await handle.stop(entityId);
```

Package layout mirrors the existing subpath pattern (`./postgres`, `./bullmq`,
`./timer`): adapters live at `./langgraph`, `./anthropic`, `./eve` with
optional peer dependencies, so one install covers everything and adapters
can't drift from the engine version.

## What "state of the art" means here, concretely

- **Crash-safety over vibes**: idempotency claimed before side effects; wakes
  that die mid-run cannot double-fire governed actions on retry.
- **Every prompt is data-last**: principles in the system prompt, facts in the
  briefing — the prism lesson.
- **Denials teach the model**: governance outcomes flow back in-band as tool
  results, never as silent failures.
- **No silent truncation**: transcript normalization states its limits;
  anything dropped is dropped visibly.
- **Zero core dependencies**, optional peers per adapter, Node ≥ 20, strict
  TS, ESM.
- **Tests are deterministic**: fake adapters, scripted models, no network, no
  clocks.
