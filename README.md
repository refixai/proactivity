# @refix/proactivity

<p align="center">
  <img src="https://img.shields.io/badge/LangGraph-000000?style=flat-square&logo=langchain&logoColor=white" alt="LangGraph" />
  &nbsp;
  <img src="https://img.shields.io/badge/Vercel_AI_SDK-000000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel AI SDK" />
  &nbsp;
  <img src="https://img.shields.io/badge/OpenAI_SDK-412991?style=flat-square&logo=openai&logoColor=white" alt="OpenAI SDK" />
  &nbsp;
  <img src="https://img.shields.io/badge/Anthropic_SDK-CC785C?style=flat-square&logo=anthropic&logoColor=white" alt="Anthropic SDK" />
  &nbsp;
  <img src="https://img.shields.io/badge/Mastra-000000?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MzAiIGhlaWdodD0iMjY3IiB2aWV3Qm94PSIxMTYgMTE2IDQzMCAyNjciIGZpbGw9Im5vbmUiPjxwYXRoIGZpbGw9IndoaXRlIiBkPSJNMTc0LjM2IDI2Ni4zM2MzMi4yMyAwIDU4LjM2IDI1LjkgNTguMzYgNTcuODMgMCAzMS45NC0yNi4xMyA1Ny44My01OC4zNiA1Ny44M1MxMTYgMzU2LjEgMTE2IDMyNC4xNnMyNi4xMy01Ny44MyA1OC4zNi01Ny44MyIvPjxwYXRoIGZpbGw9IndoaXRlIiBkPSJNMjUwLjc2IDExNmMzMi4yMyAwIDU4LjM2IDI1LjkgNTguMzYgNTcuODNxMCA0LjA5LS41NiA4LjAxYy0yLjk0IDIwLjk3LTcuMjYgNDQuNjIgNC42NSA2Mi4xOWwxMy43MiAyMC4yMiAzLjM5IDQuMTNjLjYyLjc1IDEuOC43MSAyLjM2LS4wOWwyLjg3LTQuMDQgMTIuNTQtMTguNWMxMi41Mi0xOC40NSA3Ljk4LTQzLjM4IDUuODMtNjUuNTFhNTggNTggMCAwIDEtLjI3LTUuNmMwLTMxLjk0IDI2LjEzLTU3LjgzIDU4LjM2LTU3LjgzczU4LjM2IDI1Ljg5IDU4LjM2IDU3LjgzcTAgNC42Ni0uNzIgOS4xMmMtMy4xOCAxOS44NC03LjczIDQxLjc3IDIuNCA1OS4xNmw1LjggOS4yOGM1LjQ4IDguNzkgMTUuMyAxMy41NyAyNS4yNiAxNi40NiAyNC4yMiA3LjA0IDQxLjkgMjkuMjIgNDEuOTEgNTUuNSAwIDMxLjk0LTI2LjEzIDU3LjgzLTU4LjM2IDU3Ljgzcy01OC4zNi0yNS44OS01OC4zNi01Ny44M3EwLTUuMTUuODgtMTAuMDVjMy40Ni0xOS41NiA4LjA0LTQxLjI0LTEuOTgtNTguNDNsLTEyLjcyLTIxLjg0LS43Ny0xLjA0YTEuNDIgMS40MiAwIDAgMC0yLjI0LS4wNmwtMTMuNiAyMC4wNWMtMTIuMiAxNy45OC03LjYgNDIuMjYtNC43NSA2My43M3EuNSAzLjc1LjUgNy42NGMwIDMxLjk0LTI2LjEzIDU3LjgzLTU4LjM2IDU3Ljgzcy01OC4zNi0yNS44OS01OC4zNi01Ny44M2MwLTIyLjY5IDMuNTQtNDguMDEtOS4yMy02Ni44NWwtMS0xLjQ5Yy0xMC4yNy0xNS4xMi0yOC40OC0yMi42My00NC41LTMxLjU3YTU3LjcgNTcuNyAwIDAgMS0yOS43Ny01MC40MmMwLTMxLjk0IDI2LjEzLTU3LjgzIDU4LjM2LTU3LjgzIi8+PC9zdmc+&logoColor=white" alt="Mastra" />
  &nbsp;
  <img src="https://img.shields.io/badge/Eve-000000?style=flat-square&logo=vercel&logoColor=white" alt="Eve" />
</p>

The TypeScript SDK for proactive agents: durable wake scheduling, cross-wake goal memory, LLM-driven cadence, and idempotent action governance.

Works with LangGraph, the Anthropic SDK, Eve, OpenClaw, and Hermes, or any loop you own.

## The problem

LangGraph, CrewAI, and friends give you a reasoning loop: you call it, it thinks, it returns. That's a reactive agent. A proactive one wakes on its own, notices what changed, pursues goals across wakes, and sets its own pace.

The moment an agent runs unsupervised, you need guardrails or you rebuild them one incident at a time: idempotency after the first double-post, rate caps after the first runaway loop, crash recovery after the first lost job, an audit trail after the first "what did it do?"

This gives you both: the wake loop and the envelope.

## Quick start

```bash
pnpm add @refix/proactivity
```

### 1. The agent you have

A ReAct agent that can read GitHub and post to Slack. Reactive: it runs when you call it, answers, and stops existing.

```ts
const agent = createReactAgent({
  llm,
  tools: [listIssues, listPullRequests, postToSlack],
  prompt: "You watch a GitHub repo and keep #eng informed.",
});
```

### 2. Make it proactive

The agent's reasoning, tools, and prompt don't change. One structural touch: the outbound tool goes through `governed()`, so it can never double-post.

```ts
import { proactive } from "@refix/proactivity";
import { fromLangGraph, governed, langchainModel } from "@refix/proactivity/langgraph";

const agent = createReactAgent({
  llm,
  tools: [listIssues, listPullRequests, governed(postToSlack)], // ← the one change
  prompt: "You watch a GitHub repo and keep #eng informed.",
});

const handle = proactive(fromLangGraph(agent), {
  // Your own LLM — it powers the SDK's reflection step (bookkeeping + pacing).
  reflection: { model: langchainModel(llm) },
  goals: [
    {
      title: "Keep #eng on top of acme/api",
      objective:
        "Each wake, check issues and PRs against what previous wakes reported. " +
        "Post to #eng when something needs a human: a new bug report, a PR stale " +
        "for 3+ days, a thread going in circles. Stay silent otherwise.",
      doneCondition: "Standing goal — never done; keep watching.",
      pinned: true, // the model can't close this goal — only you can
    },
  ],
  cadence: { min: "15m", max: "24h" }, // it picks its own pace inside this window
});

await handle.start("acme/api"); // that's it — first wake in 15 minutes
```

No store configured means in-memory; hand it Postgres when you deploy ([below](#production)). `handle.wake("acme/api")` wakes it right now (webhooks enter here).

### 3. Watch it run

Two wakes, four hours apart:

```
[proactive:acme/api] wake #1 (scheduled) — 1 goal
[proactive:acme/api] ⚙ list_issues {"repo":"acme/api"}
[proactive:acme/api] 💭 Nothing changed since the last look. No post warranted.
[proactive:acme/api] ✎ quiet repo, 14 open issues, nothing new — next wake in 4h
[proactive:acme/api] wake #1 done — next wake at 6:12 PM

        ····· four hours later ·····

[proactive:acme/api] wake #2 (scheduled) — 1 goal, last wake 4h ago
[proactive:acme/api] ⚙ list_issues {"repo":"acme/api"}
[proactive:acme/api] 💭 Two new bug reports, one looks P0. #eng should know.
[proactive:acme/api] ✔ post_to_slack — taken
[proactive:acme/api] ✎ escalated 2 new bugs to #eng — next wake in 30m (watch for movement)
[proactive:acme/api] wake #2 done (acted) — next wake at 6:47 PM
```

Wake 1: nothing new, so reflection backed off toward the 24h ceiling. Wake 2: two bug reports, one P0 — the agent decided to escalate, posted to #eng, updated its scratchpad, and tightened to 30m to watch for follow-up.

> [!TIP]
> Route the event stream to your own logger with `observe: (event) => …`, or silence it with `observe: false`.

## What you get

- **Your agent stays a black box.** It gets briefed before it runs, observed while it runs, and reflected on after. No restructuring, no framework migration.
- **Memory across wakes.** Every wake opens with a situation report: standing goals with their living scratchpads, recent wakes, actions already taken. With `report: { summarizeOlderWakes: true }`, history that ages out folds into a rolling summary — wake #500 still knows what wake #3 promised.
- **Self-set cadence.** After each wake, reflection picks the next one between your `min` and `max`: sooner while things are changing, backed off when quiet. `handle.wake()` is the event-driven entry.
- **Governed actions: idempotent, capped, audited.** Wrap a tool with `governed()` and it gets an idempotency key claimed before the side effect, a per-wake action cap, and an audit row for every attempt. Whether a wake "acted" is derived from the audit trail, not from what the model claims. Denials go back to the model so it replans instead of retrying blindly.
- **Reflection on your own model.** The SDK's reasoning step runs on the LLM client you already have (same keys, same retries, same tracing). No second provider.
- **Goals are an API.** `handle.addGoal()` when your user clicks "watch this", `handle.completeGoal()` when they stop caring. Reflection can evolve a `pinned` goal's scratchpad but can never close it.
- **Durable.** Postgres store and BullMQ scheduler for production; `handle.resume()` re-arms every loop after a restart.

## Works with your stack

**LangGraph.** `fromLangGraph(graph)` wraps any compiled graph; transcript is recorded via callbacks, subgraphs included.

**Anthropic SDK.** You keep your hand-rolled loop. `fromAnthropic()` hands it a traced client with an identical surface, so the SDK reconstructs the transcript without touching the loop (`anthropicLoop()` if you'd rather the SDK own the loop):

```ts
import { proactive } from "@refix/proactivity";
import { anthropicModel, fromAnthropic } from "@refix/proactivity/anthropic";

const handle = proactive(
  fromAnthropic({
    client: anthropic,
    // Your existing call → execute tools → feed results back loop. It opens
    // with the injected situation report where a hardcoded request used to be.
    run: ({ client, message }) => briefingLoop(client, tools, message),
  }),
  {
    reflection: { model: anthropicModel(anthropic, "claude-sonnet-5") },
    goals: [/* same as above */],
    cadence: { min: "15m", max: "24h" },
  },
);
```

A hand-rolled loop has no tool object to wrap, so govern the side effect directly: `governedPerform({ actionType, target, perform })` is the same envelope without the wrapper.

**Eve.** `createEveProactivity()` from `@refix/proactivity/eve` is built with Eve's grain: hooks, a due-gate over Eve's static cron, and a terminal `finish_heartbeat` tool.

**OpenClaw / Hermes** — ship as plugins. Paste this into your agent:

```
Install and enable the proactivity plugin: run `openclaw plugins install npm:@refix/proactivity-openclaw`, then `openclaw plugins enable proactivity`. Confirm both commands succeeded. If either fails, follow https://github.com/refixai/proactivity/tree/main/integrations/openclaw.
```

```
Install and enable the proactivity plugin: run `pip install proactivity-hermes`, then `hermes plugins enable proactivity`. Confirm both commands succeeded. If either fails, follow https://github.com/refixai/proactivity/tree/main/integrations/hermes.
```

Both add the governance envelope, durable goals, and a `set_cadence` tool to your existing agent. Config and honest limitations: [`integrations/openclaw`](integrations/openclaw), [`integrations/hermes`](integrations/hermes).

**Anything else.** An adapter is `{ name, run(input) => Promise<Transcript> }`. Three concerns, nothing else.

## How a wake runs

Every wake runs four moments:

1. **Inject:** a situation report built from the store (goals + their scratchpads, recent wakes, actions already taken) arrives as the agent's message. Shape it or replace it with the `agentInput` callback; statefulness is your dial.
2. **Run:** your unchanged agent executes. Tools you wrapped with `governed()` pass through the governance envelope; everything else runs untouched. Outside a wake, governed tools are transparent passthroughs.
3. **Reflect:** one structured-output call on *your* model reads the full transcript, writes the ledger entry, evolves each goal's scratchpad, and picks the next wake time. Always on; a failed reflection degrades to safe defaults instead of failing the wake.
4. **Schedule:** the scheduler re-arms at the reflected cadence.

## Production

The in-memory store is for development. In production the store holds everything — goals, ledger, audit trail, schedule — so the process is disposable:

```bash
pnpm add pg bullmq   # optional peers for /postgres and /bullmq
```

```ts
import { proactive } from "@refix/proactivity";
import { createPostgresStore } from "@refix/proactivity/postgres";
import { createBullMQAdapter } from "@refix/proactivity/bullmq";

const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });
await store.migrate(); // idempotent; safe to run on every boot

const handle = proactive(adapter, {
  reflection: { model },
  goals,
  store,
  schedule: createBullMQAdapter({ queueName: "wakes", connection: { host: "localhost", port: 6379 } }),
});

await handle.resume(); // after a restart: re-arm every entity that should be running
```

`migrate()` creates `proactivity_*`-prefixed tables alongside your own; `createPostgresStore` also takes a `pg.Pool` you already manage.

## Overrides

The defaults are opinionated so the quick start stays short. Each layer can be replaced:

| Override | How |
|----------|-----|
| What your agent sees each wake | `agentInput: (ctx) => …` — goals, ledger, and rolling summary in; any input shape out. The rendered report stays available as `ctx.report`. |
| Whether a wake happens at all | `shouldWake: (ctx) => boolean` — the only pre-model gate. Cost control only; judgment stays with the agent. |
| Reflection's guidance | `reflection.instructions` — product-specific guidance appended to the goals / scheduling / ledger sections of the prompt. |
| Reflection's prompt | `reflection.prompt: (ctx) => string` — full prompt takeover; the output schema stays enforced. |
| Reflection itself | `reflection.run: (ctx) => Promise<unknown>` — replace the single call with anything: a sub-agent over the store, a deep pass every Nth wake. Output is still validated and clamped. |
| Report depth | `report.recentWakes` (default 5), `report.summarizeOlderWakes` (default off). |
| Action ceiling | `governance.maxActionsPerWake` (default 10). |
| Logging and errors | `observe` (a function routes the event stream, `false` silences it), `onError`. |
| Storage and scheduling | `store` (any `ProactivityStore`), `schedule` (any `SchedulerAdapter`). |

A few things are deliberately not configurable: reflection always runs, idempotency is claimed before the side effect, `pinned` can never be set by model output, and observers can never fail a wake.

## Under the hood

`proactive()` is compiled from documented, individually usable primitives (a scheduler, a heartbeat, a goal store, and the governance envelope) that share one store. When the wrapper stops fitting your flow, dropping one layer down isn't a migration: same tables, same ledger, same scheduler. The primitives layer, plan/act mode, and per-framework wiring patterns are documented in [`PRIMITIVES.md`](PRIMITIVES.md), with runnable, compile-checked examples under [`examples/`](examples).

## License

Apache-2.0. See [LICENSE](LICENSE).
