# @refixai/proactivity

Proactivity primitives for autonomous agents. Scheduling, governance, goals, and briefing, so your agent can act on its own without spamming, repeating itself, or running away.

## The problem

Frameworks like LangGraph and CrewAI give you a reasoning loop: you call it, it thinks, it returns. That is a reactive agent. A proactive one runs on its own. It wakes on its own schedule, notices what changed since it last looked, pursues goals it set earlier, and decides its own pace. None of that comes with the reasoning loop.

And the moment an agent runs on its own, it needs guardrails, or you rebuild them one incident at a time: idempotency after the first spam, rate caps after the first runaway loop, crash-safe scheduling after the first lost job, an audit trail after the first "what did it do?"

This gives you both: the loop that makes an agent proactive, and the envelope that keeps it from spamming, repeating itself, or running away.

## How the loop runs

An agent built on this SDK runs itself. You wire it up once, call `scheduler.start(entityId)`, and from then on it wakes on its own schedule, decides what to do, acts, and chooses when to wake next. Four pieces make that work:

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

Most of this README is about governance because it has the most surface area, but governance never starts anything. The scheduler and the heartbeat are what make the agent act on its own.

## Install

```bash
pnpm add @refixai/proactivity
```

Optional adapters (install what you use):

```bash
pnpm add pg        # for @refixai/proactivity/postgres
pnpm add bullmq    # for @refixai/proactivity/bullmq
```

## Quick start

The smallest agent that runs itself. It needs no database and no Redis: the
in-memory store and the timer adapter run entirely in-process. Swap in
`createPostgresStore` and `createBullMQAdapter` for production.

```typescript
import { createHeartbeat, createScheduler, createTestStore } from '@refixai/proactivity'
import { createTimerAdapter } from '@refixai/proactivity/timer'

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
decides to do through governance. The seam is the same in every framework:

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

| Framework | How actions reach governance |
|-----------|------------------------------|
| LangGraph | Govern the tool |
| Vercel AI SDK | Govern the tool |
| OpenAI SDK | Parse, then dispatch |
| Anthropic SDK | Parse, then dispatch |
| Mastra | Parse, then dispatch |

Anything not listed fits one of these: govern the tool if the model calls tools itself, parse then dispatch if it returns actions for you to run.

### LangGraph or Vercel AI SDK: govern the tool

The model calls tools, so wrap each side-effecting tool to dispatch through
governance. Bind the current `goalId` and `goalTickId` when you build the tool,
then hand it to your graph:

```typescript
import { tool } from '@langchain/core/tools'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import { buildTickPrompt } from '@refixai/proactivity/prompts'
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
  // Returning the outcome lets the model see "taken" or "hard_denied" and re-plan.
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

Either shape gets the caps, idempotency, and audit trail for free. Runnable
versions of both, across five frameworks, live in
[`src/integrations.test.ts`](src/integrations.test.ts).

## Core primitives

### Scheduler: self-adjusting attention

The agent decides its own wake-up interval. It isn't a fixed cron: the agent reasons about how closely to watch based on what it observes.

```typescript
import { createScheduler } from '@refixai/proactivity'
import { createBullMQAdapter } from '@refixai/proactivity/bullmq'

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

Goals have a lifecycle (`active → paused → completed → archived`), priority levels, and mutation validation that rejects contradictory batches such as creating and archiving the same goal at once.

### Governance envelope: safe side effects

Every action the agent takes goes through governance, which handles:

- Idempotency: deterministic keys prevent duplicate actions across retries
- Hard caps: per-pass and per-tick action limits (a hard stop with no override)
- Soft caps: warnings with optional override reasoning
- Dry-run mode: records every action as `pending_approval` without executing it
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

// result.governanceOutcome: 'taken' | 'hard_denied' | 'soft_cap_overridden' | 'pending_approval'
```

Governance never throws. Side-effect failures are caught and wrapped in a denial result.

## Plan/Act mode (optional)

For complex agents, split reasoning into a planner (mutates goals, selects which to work on) and an executor (works on one goal at a time):

```typescript
import { createPlanActHeartbeat } from '@refixai/proactivity'

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
    const { governanceOutcome } = await governance.dispatch({
      goalId: goal.id, goalTickId,
      actionType: 'send_follow_up',
      target: { goalId: goal.id },
      reasoning: 'Following up on this goal',
      perform: async () => { /* ...send the messages... */ },
    })
    return { acted: governanceOutcome === 'taken', summary: 'Sent follow-up' }
  },
})
```

## Adapters

| Subpath | Purpose | Peer Dep |
|---------|---------|----------|
| `@refixai/proactivity` | Core primitives + `createTestStore` (zero deps) | none |
| `@refixai/proactivity/postgres` | Production store (raw SQL, ships migrations) | `pg` |
| `@refixai/proactivity/bullmq` | Production scheduler (self-rescheduling) | `bullmq` |
| `@refixai/proactivity/timer` | setTimeout scheduler for development | none |
| `@refixai/proactivity/prompts` | Tick / planner / executor prompt builders | none |

### Postgres store

`createPostgresStore` takes either a connection string or a `pg.Pool` you
already have, so it can share your app's existing connection:

```typescript
import { createPostgresStore } from '@refixai/proactivity/postgres'

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

## License

MIT
