// Anthropic SDK example: "parse, then dispatch".
//
// The model returns a structured plan of actions (guaranteed-valid JSON via
// structured outputs); the tick loops over them and routes each side effect
// through governance.dispatch. The same pattern applies to the OpenAI SDK and
// Mastra — only the SDK call changes.

import Anthropic from '@anthropic-ai/sdk'
import { createHeartbeat, createScheduler, createTestStore } from '@refixai/proactivity'
import { createTimerAdapter } from '@refixai/proactivity/timer'
import { buildTickPrompt } from '@refixai/proactivity/prompts'

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY to run this example.')
  process.exit(1)
}

const client = new Anthropic()

const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['actions', 'cadenceHint'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['actionType', 'target', 'reasoning'],
        properties: {
          actionType: { type: 'string' },
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['userId'],
            properties: { userId: { type: 'string' } },
          },
          reasoning: { type: 'string' },
        },
      },
    },
    cadenceHint: {
      type: 'object',
      additionalProperties: false,
      required: ['nextTickMs', 'reasoning'],
      properties: {
        nextTickMs: { type: 'number' },
        reasoning: { type: 'string' },
      },
    },
  },
}

type TickPlan = {
  actions: Array<{ actionType: string; target: { userId: string }; reasoning: string }>
  cadenceHint: { nextTickMs: number; reasoning: string }
}

const store = createTestStore()

// Tiny cadence so you can watch the loop in real time. Real agents use
// 15 minutes to 24 hours.
const cadence = { min: 5_000, max: 60_000, default: 5_000 }

// Stand-in signal source: one new signup on the first tick, then quiet.
const pendingSignups = ['u_alice']

const goalId = 'welcome-new-signups'

const heartbeat = createHeartbeat({
  store,
  cadence,
  sources: [{ name: 'newSignups', load: async () => pendingSignups.splice(0) }],
  governance: { store, caps: { perPass: 3, perTick: 10 } },
  tick: async ({ briefing, goals, governance, boundary }) => {
    // First tick: seed a durable goal so actions have something to attribute to.
    if (!goals.some((g) => g.id === goalId)) {
      await store.applyGoalMutations(boundary.tickId, [
        {
          op: 'create',
          goalId,
          title: 'Welcome new signups',
          objective: 'Send each new signup a welcome message',
          doneCondition: 'Every new signup has been welcomed',
          reasoning: 'The newSignups source is live',
        },
      ])
    }
    const activeGoals = await store.listGoals(boundary.entityId, { status: ['active'] })

    // Open a goal-tick: this tick's work on the goal, referenced by every dispatch.
    const goalTickId = await store.insertGoalTick({
      goalId,
      tickId: boundary.tickId,
      orderIndex: 0,
    })

    const system = [
      buildTickPrompt({
        briefing,
        goals: activeGoals,
        entityId: boundary.entityId,
        tickNumber: boundary.tickNumber,
      }),
      'Output JSON of the shape { actions: [{ actionType: string, target: { userId: string }, reasoning: string }], cadenceHint: { nextTickMs: number, reasoning: string } }.',
      'Emit one "send_welcome_email" action per new signup in the briefing; no new signups means an empty actions array. nextTickMs must be between 5000 and 60000.',
    ].join('\n\n')

    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: 'Run your tick.' }],
      output_config: { format: { type: 'json_schema', schema: planSchema } },
    })

    const textBlock = response.content.find((block) => block.type === 'text')
    if (!textBlock) throw new Error(`no text block in response (stop_reason: ${response.stop_reason})`)
    const plan = JSON.parse(textBlock.text) as TickPlan

    console.log(`tick #${boundary.tickNumber}: model planned ${plan.actions.length} action(s)`)

    // Every planned side effect goes through the governance envelope.
    for (const action of plan.actions) {
      const { governanceOutcome } = await governance.dispatch({
        goalId,
        goalTickId,
        actionType: action.actionType,
        target: action.target,
        reasoning: action.reasoning,
        perform: async () => {
          console.log(`  [perform] ${action.actionType} -> ${action.target.userId} (stand-in, no real side effect)`)
        },
      })
      console.log(`  [governance] ${action.actionType} on ${action.target.userId}: ${governanceOutcome}`)
    }

    return { cadenceHint: plan.cadenceHint }
  },
})

let ticksRun = 0

const scheduler = createScheduler({
  adapter: createTimerAdapter(),
  store,
  cadence,
  identity: (entityId) => `heartbeat:${entityId}`,
  onTick: async (entityId, trigger) => {
    const result = await heartbeat.runTick(entityId, trigger)
    console.log(`  tick ${result.status}; actions taken: ${result.actionsTakenCount}; next wake in ~${result.nextCadenceMs}ms\n`)
    if (++ticksRun >= 3) {
      console.log('Demo complete after 3 ticks.')
      await scheduler.stop(entityId)
      process.exit(0)
    }
    return result
  },
  onError: (error, entityId) => {
    console.error(`scheduler error for ${entityId}:`, error)
    process.exit(1)
  },
})

console.log('Starting proactive agent: 3 ticks, ~5s apart. Watch it act, then go quiet.\n')
await scheduler.start('demo')
