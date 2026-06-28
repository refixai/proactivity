# @refixai/proactivity

Proactivity primitives for autonomous agents. Scheduling, governance, goals, and briefing — so your agent can act on its own without spamming, repeating itself, or running away.

## The Problem

Every team deploying an autonomous agent rebuilds the same infrastructure: idempotency guards after the first spam incident, rate limiting after the first runaway loop, crash-safe scheduling after the first lost job, audit trails after the first "what did the agent do?" question.

LangGraph, CrewAI, and other frameworks give you the reasoning loop. This gives you everything around it.

## Install

```bash
pnpm add @refixai/proactivity
```

Optional adapters (install what you use):

```bash
pnpm add pg        # for @refixai/proactivity/postgres
pnpm add bullmq    # for @refixai/proactivity/bullmq
```

## Quick Start

```typescript
import { createHeartbeat, createTestStore } from '@refixai/proactivity'
import { createTimerAdapter } from '@refixai/proactivity/timer'

const store = createTestStore() // in-memory, for dev/tests — use createPostgresStore for production

const heartbeat = createHeartbeat({
  store,
  cadence: { min: 15 * 60_000, max: 24 * 60 * 60_000, default: 60 * 60_000 },
  governance: { store, caps: { perPass: 3, perTick: 10 } },
  tick: async ({ briefing, goals, governance }) => {
    // Your agent logic here.
    // Use governance.dispatch() for every side effect — it handles
    // idempotency, rate limiting, and audit trails automatically.

    await governance.dispatch({
      goalId: goals[0].id,
      goalTickId: 'tick-1',
      actionType: 'send_email',
      target: { userId: 'user-123' },
      reasoning: 'Weekly summary is due',
      perform: async () => {
        // The actual side effect — only runs if governance approves
        await sendEmail('user-123', 'Your weekly summary')
      },
    })

    return { cadenceHint: { nextTickMs: 60 * 60_000, reasoning: 'Check back in 1 hour' } }
  },
})

const result = await heartbeat.runTick('entity-1', 'manual')
```

## Core Primitives

### Scheduler — Self-Adjusting Attention

The agent decides its own wake-up interval. Not a fixed cron — the agent reasons about how closely to watch based on what it observes.

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

### Briefing Assembler — Delta-Aware Context

Register data sources. Each receives a `BriefingBoundary` with a `deltaCutoff` timestamp — "what's new since last tick."

```typescript
const sources = [
  { name: 'newUsers', load: async (boundary) => db.users.since(boundary.deltaCutoff) },
  { name: 'openTickets', load: async () => db.tickets.where({ status: 'open' }) },
]

// Pass `sources` to your heartbeat config. Each tick runs them in parallel
// against that tick's boundary — assembleBriefing(sources, boundary) —
// producing { newUsers: [...], openTickets: [...] }.
```

### Goal Store — Durable Missions

Persistent goals that survive across ticks. The agent pursues missions it set for itself, not just reacting to signals.

Goals have a lifecycle (`active → paused → completed → archived`), priority levels, and mutation validation — no creating and archiving the same goal in one batch.

### Governance Envelope — Safe Side Effects

Every action the agent takes goes through governance. It handles:

- **Idempotency** — deterministic keys prevent duplicate actions across retries
- **Hard caps** — per-pass and per-tick action limits (hard stop, no override)
- **Soft caps** — warnings with optional override reasoning
- **Dry-run mode** — record all actions as `pending_approval` without executing
- **Audit trail** — every attempt recorded with outcome, reasoning, and error

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

## Plan/Act Mode (Optional)

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
  executor: async ({ goal, governance }) => {
    // Work on a single goal. Use governance.dispatch() for side effects.
    return { acted: true, summary: 'Sent follow-up messages to 3 users' }
  },
})
```

## Adapters

| Subpath | Purpose | Peer Dep |
|---------|---------|----------|
| `@refixai/proactivity` | Core primitives + `createTestStore` (zero deps) | — |
| `@refixai/proactivity/postgres` | Production store (raw SQL, ships migrations) | `pg` |
| `@refixai/proactivity/bullmq` | Production scheduler (self-rescheduling) | `bullmq` |
| `@refixai/proactivity/timer` | setTimeout scheduler for development | — |

### Custom Stores

The bundled Postgres store and `createTestStore` cover most needs, but the
backend is a public extension point. Implement the `ProactivityStore` interface
to persist to any database — the `Insert*` / `*Patch` types exported from the
root are its method payloads. Likewise, implement `SchedulerAdapter` to drive
the loop from a queue other than BullMQ. If you only use the bundled adapters,
you never touch these types.

## Derived From Production

These primitives are extracted from [Oracle](https://refix.ai), an autonomous agent that has run thousands of production heartbeats — sending real messages to real users with governance, self-adjusting cadence, and crash recovery. The patterns here are battle-tested, not theoretical.

## License

MIT
