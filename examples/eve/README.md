# Eve example — govern the tool, Eve-native trigger

A proactive [Eve](https://github.com/vercel/eve) agent on `@refixai/proactivity`:
a personal agent that watches for conversations you've left on read and nudges
you to reply — **once per thread**, because the governance envelope won't let it
nag you twice about the same conversation.

Eve is filesystem-first, so this is an `agent/` app, not a single script — and
the proactive trigger is **Eve-native**: its own cron wakes the agent, and
proactivity adds the governance envelope, the durable goal, and the audit ledger
on top.

## The pattern

Eve tools live in their own files, so a tool can't close over the tick's
`governance` the way a LangGraph tool does. Instead a `session.started` hook
opens the tick and stashes its ids in `defineState`, and the file-based tools
read them back:

| File | Role |
|---|---|
| `agent/schedules/reply-followups.ts` | Eve-native cron — the proactive trigger; its markdown prompt is the tick instruction |
| `agent/hooks/open-tick.ts` | `session.started` hook: records the tick, ensures the goal, opens a goal-tick, seeds the tick's ids into `tickState` |
| `agent/tools/list_pending_replies.ts` | reads the briefing (threads you owe a reply to) out of `tickState` |
| `agent/tools/send_followup_nudge.ts` | **the governed tool** — rebuilds the envelope from the tick ids + shared store and calls `governance.dispatch`; `target: { threadId }` is what makes "don't nag twice" hold |
| `agent/proactivity.ts` | shared store + the `defineState` tick slot |
| `agent/agent.ts`, `agent/channels/eve.ts` | minimal agent + HTTP channel so it's a complete app |

The hook is the seeding point because it runs inside an eve context, where
`tickState.update` is legal; a schedule `run` handler does not.

### Why the tool rebuilds governance instead of reading a live handle

Eve is a **durable-workflow runtime**: it serializes `defineState` across step
boundaries, so state must be plain JSON. A `GovernanceHandle` holds a `dispatch`
function, which can't be serialized — stashing it in `tickState` throws
`Cannot stringify a function` at the first step boundary. So the hook seeds only
the tick's **ids**, and `send_followup_nudge` rebuilds the envelope from them
plus the shared `store`. Idempotency (the "once per thread" guarantee) survives
the rebuild because it's enforced by the store on `tickId`, not by the in-memory
handle. The shape-sim in [`src/integrations.test.ts`](../../src/integrations.test.ts)
models the ALS read with `AsyncLocalStorage`, which holds live objects fine — so
it doesn't surface this; the real Eve runtime does.

## Verify

```bash
pnpm install
pnpm typecheck        # tsc --noEmit against real eve + @refixai/proactivity types
pnpm exec eve build   # fully compiles the agent: discovers the tools, hook,
                      # schedule (cron parsed), and channel, and bundles the SDK
```

Both run offline — no AI Gateway key needed. `eve build` is the stronger check:
it discovers and compiles every component, so it catches structural mistakes
`tsc` can't (a missing instructions prompt, an unresolved model, a bad cron).

The SDK is linked from the repo root via `file:../..` and must be built first
(`pnpm build` at the root — already done if `dist/` exists).

## Run it live

Unlike the other two examples, you don't run this with `tsx`; Eve is a runtime.
The model is a bare id routed through the **Vercel AI Gateway**, so link the
project (or set `AI_GATEWAY_API_KEY`) to give Eve a key:

```bash
pnpm exec eve link          # pulls AI Gateway credentials
```

Then build, start the server, and trigger a tick:

```bash
pnpm exec eve build
pnpm exec eve start --port 3123          # serves /eve/v1
curl -X POST localhost:3123/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Run your proactive tick now."}'
```

You'll see the governed side effect in the server log —
`[nudge] t_alex: You left Alex's message on read…` — and the `send_followup_nudge`
tool result `{"governanceOutcome":"taken"}`.

Prefer a provider directly (e.g. OpenRouter) instead of the gateway? Point
`model` at an AI SDK provider instance, which Eve routes as an external provider
(no `eve link`):

```ts
import { createOpenAI } from "@ai-sdk/openai";
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});
// model: openrouter.chat("anthropic/claude-opus-4.8")
```

Use `@ai-sdk/openai` (version-aligned with Eve's AI SDK), not
`@openrouter/ai-sdk-provider`, which is still on AI SDK v6 while Eve is on v7.

The demo uses an in-memory store, so goals and the ledger reset on restart —
swap `createTestStore()` in `agent/proactivity.ts` for the postgres adapter
(`@refixai/proactivity/postgres`) to make them durable across restarts (and to
share state across processes/replays).

## Honest limitations

- **Cadence rides Eve's cron.** The schedule fires on a fixed interval; the
  SDK's self-adjusting cadence isn't expressed here (it's first-class only on
  infrastructure Refix controls). Governance and durable goals are what
  proactivity adds on top of an Eve-native trigger.
- **In-memory store.** Per-process only; see above for the durable swap.
