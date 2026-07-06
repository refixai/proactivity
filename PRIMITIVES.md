# The primitives

`proactive()` (see the [README](README.md)) is compiled from the primitives
documented here — same store, same ledger, same scheduler. Use this layer
directly when you want to own the loop yourself: custom tick logic, your own
briefing sources, plan/act splits, or a wake pipeline the wrapper's shape
doesn't fit. Ejecting one layer down is not a migration.

## How the loop runs

An agent built on this SDK runs itself. You wire it up once, call
`scheduler.start(entityId)`, and from then on it wakes on its own schedule,
decides what to do, acts, and chooses when to wake next. Four pieces make that
work:

- The **scheduler** is the clock. It wakes the agent, and after each wake it re-arms itself for the next one. This is the piece that makes the agent proactive instead of waiting for a request.
- The **heartbeat** is a single wake, called a tick. Each tick gathers fresh context, loads the agent's goals, and hands both to your reasoning loop (LangGraph, a raw LLM call, whatever you use).
- The **goal store** is memory. Goals persist across ticks, so the agent pursues missions it set earlier instead of starting from nothing each time.
- The **governance envelope** is the seatbelt. Every side effect, an email or a Slack message, passes through it so the agent cannot double-send or exceed the limits you set.

```
  scheduler.start(entity)
        |
        |   (repeats on its own)
        v
  +-----------------------------------------+
  | WAKE (one tick)                         |
  |   1. gather a briefing (what changed)   |
  |   2. load goals                         |
  |   3. your agent reasons on both         |
  |   4. governance.dispatch() each action  |
  |   5. return "wake me again in N min"    |
  +-----------------------------------------+
        |
        v
  scheduler waits N min, then wakes again
```

Most of this document is about governance because it has the most surface
area, but governance never starts anything. The scheduler and the heartbeat
are what make the agent act on its own.

## Quick start

The smallest agent that runs itself. It needs no database and no Redis: the
in-memory store and the timer adapter run entirely in-process. Swap in
`createPostgresStore` and `createBullMQAdapter` for production.

```typescript
import { createHeartbeat, createScheduler, createTestStore } from '@refix/proactivity'
import { createTimerAdapter } from '@refix/proactivity/timer'

const store = createTestStore()

// Tiny cadence so you can watch it loop in real time. Real agents use 15
// minutes to 24 hours.
const cadence = { min: 2_000, max: 60_000, default: 5_000 }

// A stand-in data source. It reports one new signup on the first wake, then
// goes quiet, so you can watch the agent speed up and then back off.
const pendingSignups = ['u_alice']

const heartbeat = createHeartbeat({
  store,
  cadence,
  sources: [{ name: 'newSignups', load: async () => pendingSignups.splice(0) }],
  governance: { store, caps: { perPass: 3, perTick: 10 } },
  tick: async ({ briefing, boundary }) => {
    const newSignups = (briefing.newSignups as string[]) ?? []
    console.log(`wake #${boundary.tickNumber}: ${newSignups.length} new signup(s)`)

    // The agent sets its own next wake: busy now, look again soon; quiet, back off.
    return newSignups.length > 0
      ? { cadenceHint: { nextTickMs: 2_000, reasoning: 'activity, stay close' } }
      : { cadenceHint: { nextTickMs: 15_000, reasoning: 'quiet, back off' } }
  },
})

const scheduler = createScheduler({
  adapter: createTimerAdapter(),
  store,
  cadence,
  identity: (entityId) => `heartbeat:${entityId}`,
  onTick: (entityId, trigger) => heartbeat.runTick(entityId, trigger),
})

// The only call you make. The agent wakes itself from here until you stop it.
await scheduler.start('workspace-1')
// ...later: await scheduler.stop('workspace-1')
```

This tick only reads and logs. To make the agent actually do something, the next
section wires in your reasoning loop and routes its actions through governance.

## Plugging in your agent

A real tick hands the context to your reasoning loop and routes whatever it
decides to do through governance. The pattern is the same in every framework:

1. Build a prompt from the tick context with `buildTickPrompt` (or assemble your own).
2. Run your agent on it.
3. Route every side effect through `governance.dispatch`.

`dispatch` needs to know which goal an action advances. `goalId` is that goal;
`goalTickId` records this tick's work on it, which you open with
`store.insertGoalTick({ goalId, tickId: boundary.tickId, orderIndex: 0 })`.
(Plan/Act mode does this bookkeeping for you.)

Every framework gets the same proactive loop: the scheduler wakes it, goals
persist across ticks, and it sets its own cadence. The framework only runs
inside the `tick`. The one thing that differs is how the model's chosen actions
reach `governance.dispatch`, and that comes down to whether the framework calls
tools itself.

| Framework | How actions reach governance | Runnable example |
|-----------|------------------------------|------------------|
| LangGraph | Govern the tool | [`examples/langgraph`](examples/langgraph) |
| Vercel AI SDK | Govern the tool | same pattern: [`examples/langgraph`](examples/langgraph) |
| OpenAI SDK | Parse, then dispatch | same pattern: [`examples/anthropic`](examples/anthropic) |
| Anthropic SDK | Parse, then dispatch | [`examples/anthropic`](examples/anthropic) |
| Mastra | Parse, then dispatch | same pattern: [`examples/anthropic`](examples/anthropic) |
| Eve | Govern the tool (Eve-native trigger) | [`examples/eve`](examples/eve) |

Anything not listed fits one of these: govern the tool if the model calls tools itself, parse then dispatch if it returns actions for you to run. Each pattern has one runnable, compile-checked example under [`examples/`](examples) with the real framework as a dependency; the pattern for every framework in the table is also shape-tested (against framework-shaped stand-ins, not the frameworks themselves) in [`src/integrations.test.ts`](src/integrations.test.ts).

### LangGraph or Vercel AI SDK: govern the tool

The model calls tools, so wrap each side-effecting tool to dispatch through
governance. Bind the current `goalId` and `goalTickId` when you build the tool,
then hand it to your graph:

```typescript
import { tool } from '@langchain/core/tools'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import { buildTickPrompt } from '@refix/proactivity/prompts'
import { z } from 'zod'

// ...as the `tick` of your createHeartbeat config:
tick: async ({ briefing, goals, governance, boundary }) => {
  const goal = goals[0]
  if (!goal) return { cadenceHint: { nextTickMs: 60 * 60_000, reasoning: 'no goals yet' } }

  // Open a goal-tick so each action is tied to the goal it advances.
  const goalTickId = await store.insertGoalTick({
    goalId: goal.id, tickId: boundary.tickId, orderIndex: 0,
  })

  // The model calls send_email; the side effect routes through governance.
  // Returning the outcome lets the model see "taken", "hard_denied" (terminal),
  // or "soft_cap_denied" (retriable with an overrideReason) and re-plan.
  const sendEmail = tool(
    async ({ userId, body }) => {
      const { governanceOutcome } = await governance.dispatch({
        goalId: goal.id, goalTickId,
        actionType: 'send_email',
        target: { userId },
        reasoning: `Email ${userId}`,
        perform: async () => { await mailer.send(userId, body) },
      })
      return governanceOutcome
    },
    {
      name: 'send_email',
      description: 'Email a user',
      schema: z.object({ userId: z.string(), body: z.string() }),
    },
  )

  const agent = createReactAgent({ llm: new ChatOpenAI({ model: 'gpt-4o' }), tools: [sendEmail] })
  await agent.invoke({
    messages: [{ role: 'user', content: buildTickPrompt({
      briefing, goals, entityId: boundary.entityId, tickNumber: boundary.tickNumber,
    }) }],
  })

  return { cadenceHint: { nextTickMs: 30 * 60_000, reasoning: 'follow up soon' } }
}
```

### Eve

Eve tools live in their own files, so a tool can't close over the tick's
`governance` the way a LangGraph tool does. A `session.started` hook opens the
tick (goal, goal-tick) and seeds the tick's **ids** into `defineState`; the
governed tool reads those ids back and rebuilds the envelope from them plus the
shared store. It rebuilds rather than reading a live handle out of state because
Eve is a durable-workflow runtime that serializes `defineState` across steps —
a `GovernanceHandle` holds a function and can't be serialized. Idempotency still
holds because it's enforced by the store on `tickId`, not by the in-memory
handle. Eve also ships native cron schedules, so the proactive trigger is
Eve-native; the durable goals, governance, and audit ledger are what proactivity
adds on top. Runnable example: [`examples/eve`](examples/eve) (verified live
end-to-end); the pattern is also shape-tested in
[`src/integrations.test.ts`](src/integrations.test.ts).

### OpenAI, Anthropic, or Mastra: parse, then dispatch

The model returns structured actions instead of calling tools. Loop over them
and dispatch each:

```typescript
const plan = await model.respond(prompt) // your SDK call
for (const action of plan.actions) {
  await governance.dispatch({
    goalId: goal.id, goalTickId,
    actionType: action.actionType,
    target: action.target,
    reasoning: action.reasoning,
    perform: async () => { await execute(action) },
  })
}
return { cadenceHint: plan.cadenceHint }
```

Either shape gets the caps, idempotency, and audit trail for free. A runnable
example of each pattern lives in [`examples/`](examples) —
[`examples/langgraph`](examples/langgraph) (govern the tool) and
[`examples/anthropic`](examples/anthropic) (parse, then dispatch) — built
against the real frameworks and typechecked in CI. The shape of the pattern
for all six frameworks is additionally covered by simulation tests in
[`src/integrations.test.ts`](src/integrations.test.ts).

## Core primitives

### Scheduler: self-adjusting attention

The agent decides its own wake-up interval. It isn't a fixed cron: the agent reasons about how closely to watch based on what it observes.

```typescript
import { createScheduler } from '@refix/proactivity'
import { createBullMQAdapter } from '@refix/proactivity/bullmq'

const scheduler = createScheduler({
  adapter: createBullMQAdapter({ queueName: 'heartbeats', connection: { host: 'localhost', port: 6379 } }),
  store,
  cadence: { min: 15 * 60_000, max: 24 * 60 * 60_000, default: 24 * 60 * 60_000 },
  identity: (entityId) => `heartbeat:${entityId}`,
  onTick: (entityId, trigger) => heartbeat.runTick(entityId, trigger),
})

await scheduler.start('entity-1')
```

Failures auto-recover: null cadence hint defaults to `cadence.default`, and `seedFromStore()` re-enqueues missed jobs on restart.

### Briefing assembler: delta-aware context

Register data sources. Each receives a `BriefingBoundary` with a `deltaCutoff` timestamp marking what is new since the last tick.

```typescript
const sources = [
  { name: 'newUsers', load: async (boundary) => db.users.since(boundary.deltaCutoff) },
  { name: 'openTickets', load: async () => db.tickets.where({ status: 'open' }) },
]

// Pass `sources` to your heartbeat config. Each tick runs them in parallel
// against that tick's boundary via assembleBriefing(sources, boundary),
// producing { newUsers: [...], openTickets: [...] }.
```

### Goal store: durable missions

Persistent goals that survive across ticks. The agent pursues missions it set for itself, not just reacting to signals.

Goals have a lifecycle (`active → paused → completed → archived`), priority levels, and mutation validation that enforces the status machine on LLM-emitted batches: at most one mutation per goal per batch, terminal and unknown goals are immutable, pause requires active, and `update`'s `status` field is the pause/resume path.

### Governance envelope: safe side effects

Every action the agent takes goes through governance, which handles:

- Idempotency: deterministic keys prevent duplicate actions across retries
- Hard caps: per-pass and per-tick action limits (a hard stop with no override)
- Soft caps: denied with the retriable `soft_cap_denied` outcome — re-dispatch with an `overrideReason` when the action is genuinely warranted
- Dry-run mode: records every action as `pending_approval` without executing it; drafts still consume cap budget, so a dry run previews the same volume live mode would allow
- Audit trail: every attempt recorded with its outcome, reasoning, and error

```typescript
const result = await governance.dispatch({
  goalId: 'goal-1',
  goalTickId: 'gt-1',
  actionType: 'send_slack_dm',
  target: { userId: 'U123' },
  reasoning: 'User has been inactive for 7 days',
  perform: async () => { await slack.sendDm('U123', 'Hey, checking in!') },
})

// result.governanceOutcome:
//   'taken' | 'hard_denied' | 'soft_cap_denied' | 'soft_cap_overridden' | 'pending_approval'
// hard_denied is terminal for this tick; soft_cap_denied is retriable with an overrideReason.
```

Governance never throws. Side-effect failures are caught and wrapped in a denial result.

## Plan/Act mode (optional)

For complex agents, split reasoning into a planner (mutates goals, selects which to work on) and an executor (works on one goal at a time):

```typescript
import { createPlanActHeartbeat } from '@refix/proactivity'

const heartbeat = createPlanActHeartbeat({
  store,
  cadence: { min: 15 * 60_000, max: 24 * 60 * 60_000, default: 60 * 60_000 },
  governance: { store, caps: { perPass: 3, perTick: 10 } },
  planner: async ({ briefing, goals }) => ({
    goalMutations: [{ op: 'create', title: 'Follow up with inactive users', objective: '...', doneCondition: '...', reasoning: 'New signal detected' }],
    selectedGoals: [{ goalId: 'goal-1', reasoning: 'Highest priority' }],
    skippedGoals: [],
    cadenceHint: { nextTickMs: 30 * 60_000, reasoning: 'Active signals detected' },
  }),
  executor: async ({ goal, goalTickId, governance }) => {
    // Work on a single goal. The goal-tick is already open, so route side
    // effects straight through governance.
    await governance.dispatch({
      goalId: goal.id, goalTickId,
      actionType: 'send_follow_up',
      target: { goalId: goal.id },
      reasoning: 'Following up on this goal',
      perform: async () => { /* ...send the messages... */ },
    })
    // Whether the pass acted is derived from the governance ledger, not
    // reported here — an executor can't misstate what it did.
    return { summary: 'Sent follow-up' }
  },
})
```

## Adapters

| Subpath | Purpose | Peer Dep |
|---------|---------|----------|
| `@refix/proactivity` | Core primitives + `createTestStore` (zero deps) | none |
| `@refix/proactivity/postgres` | Production store (raw SQL, ships migrations) | `pg` |
| `@refix/proactivity/bullmq` | Production scheduler (self-rescheduling) | `bullmq` |
| `@refix/proactivity/timer` | setTimeout scheduler for development | none |
| `@refix/proactivity/prompts` | Tick / planner / executor prompt builders | none |

### Postgres store

`createPostgresStore` takes either a connection string or a `pg.Pool` you
already have, so it can share your app's existing connection:

```typescript
import { createPostgresStore } from '@refix/proactivity/postgres'

// Pass a connection string (the SDK creates and owns the pool)...
const store = createPostgresStore({ connectionString: process.env.DATABASE_URL })

// ...or a pg.Pool you already have:
const store = createPostgresStore({ pool: myPool })

await store.migrate() // idempotent; safe to run on every boot
```

`migrate()` creates `proactivity_*`-prefixed tables in whatever database and
`search_path` the connection points at, so they sit alongside your own tables.
`store.end()` closes the pool only when the SDK created it; a pool you passed in
is yours to manage.

### Custom stores

The bundled Postgres store and `createTestStore` cover most needs, but the
backend is a public extension point. Implement the `ProactivityStore` interface
to persist to any database. The `Insert*` / `*Patch` types exported from the
root are its method payloads. Likewise, implement `SchedulerAdapter` to drive
the loop from a queue other than BullMQ. If you only use the bundled adapters,
you never touch these types.
