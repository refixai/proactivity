
## What we did

A control experiment to measure the SDK's real integration cost. We built two deliberately ordinary agents doing the same job — read Linear tickets, compose a brief, deliver it — one on LangGraph, one on the raw Anthropic SDK. Committed as a baseline. Then we installed `@refix/proactivity` and integrated it by hand, so the git diff *is* the cost, measured not estimated. The engine worked: the scheduler ticked, governance deduped, goals persisted. The interface is the problem: the diff was **~320 lines across ten files, against agents that were ~100 lines each.** Making the agent proactive cost 3× more code than building the agent.

## Why the current state isn't enough

The SDK is a framework, not a library: it runs the loop, and your agent becomes a `compose()` callback inside it. Our agents didn't get proactivity *added* — they got disassembled and reassembled inside the SDK's worldview. That's the adoption killer: nobody restructures a working agent.

And the concept count is brutal. Before the first tick fires you must understand: store, heartbeat, scheduler, adapter, cadence, boundary, briefing, sources, goals, goal mutations, goal-ticks, governance handles, dispatch, idempotency, outcomes — ~15 concepts, all load-bearing on day one. Then the plumbing we wrote by hand: seed the goal idempotently, open goal-ticks, thread attribution ids into every dispatch, wrap each outbound tool, compute a cadence heuristic. All of it should be the runtime's job. SDKs that spread expose 1–3 concepts at the door; ours exposes the engine room.

## The sources problem

A source is `load(boundary)` — code that runs before the model and decides what it sees. The principle it violates: **"what's new" is a fact; "what matters" is a judgment.** Hand a deterministic function a judgment-shaped job and the developer ends up writing relevance as if-statements — a worse LLM in TypeScript. That defeats the point of having a model at all.

To be fair: sometimes you don't need judgment in the source. Inbox triage really can be "fetch everything since last wake, dump it in, let the model judge." Where dumb delta-dump works, it's fine. The case against sources is that for most production agents, **even the delta-dump fails** — there's no codeable fetch that captures the signal:

- **The signal is absence.** A deal silent for 10 days in Contract-Sent is a fire. Nothing changed since last wake — the delta is empty *precisely when action is needed*. No event will ever fire.
- **There are no events, only state.** A competitor's pricing page, a dashboard, a search ranking. Nothing has `updatedAt`. "What changed" only exists by comparing against what you saw last time — memory plus comparison. That's agent work, not a query.
- **The delta is too big to dump.** 10k log lines, an hour of metrics across 40 series, 300 tickets in a large org. Something must choose what to surface — and if that something is code, you're hand-writing judgment again.
- **Relevance points backwards.** An investor emails asking for churn numbers. The delta is one email; the data that matters is last quarter's — untouched since last wake, so no delta contains it. What to fetch is determined by what the new data *means*: fetch → interpret → fetch again. A source is a one-shot query; sensing is a loop with judgment between steps.
- **The pattern spans wakes.** A customer's tone degrading across three weeks of tickets. Each individual delta looks fine; the signal exists only in accumulated findings.

Every one of these forces a choice: write smarter fetch logic — congratulations, you're building the rules engine agents were supposed to replace — or let the agent sense with its own read tools plus memory of its previous wakes. The agent already has better instruments than any source: ours literally re-implemented a Linear read tool the agent already owned, behind a filter deciding what the model was allowed to see. Sources should be demoted to an optional **wake gate** answering one question — "is it worth waking the model at all?" — and never "here's what matters."

## What `proactive()` is and how it actually works

A proactive agent is a normal agent plus someone who wakes it at the right time, hands it the right context, and stops it from overdoing it. `proactive()` is that someone. Four jobs, defined by *when* they run:

- **Before — inject.** Build a situation report from what the store already knows: time, time since last wake, goals + findings, recent ledger ("last wake you briefed REX-140–144"). By default it arrives as a message to your unchanged agent. How *aware* the agent is of its own proactivity is the dev's call: a context callback exposes `{ lastRuns, reasoning history, ledger, now }` to thread into your system prompt or graph state — or ignore.
- **During — intercept.** Governance can't be post-hoc (you can't un-send an email), but it needs no restructuring: declare `govern: ["send_brief"]` and the adapter wraps those tools. Idempotency, caps, audit row — outcome returned *as the tool result*, so the model reads `hard_denied: duplicate` and stops in-context. Reads pass through untouched.
- **After — reflect.** One cheap structured-output call over the transcript: `{ goalMutations, findings, nextWake, summary }` — validated, persisted, scheduled. This deletes the goal seeding, goal-tick plumbing, and cadence heuristics we hand-wrote. It's also just better: we computed "did anything move" in TypeScript *after the model had already reasoned about exactly that question*. Skippable on no-action wakes.
- **Between — schedule + persist.** The existing scheduler, store, ledger, goal machine — unchanged. This is a re-layering, not a rewrite; the engine survives whole, and the primitives stay public as the escape hatch.

```ts
// agent.ts — untouched. Same tools, same prompt, zero diff.

// index.ts — the entire integration:
import { proactive, fromLangGraph, memoryStore } from "@refix/proactivity";

await proactive(fromLangGraph(agent), {
  reasoning: "Keep me briefed on my Linear tickets. Brief what changed; if nothing changed, do nothing.",
  govern: ["send_brief"],
  cadence: { min: "15m", max: "24h" },
  store: memoryStore(),                          // postgres(DATABASE_URL) in prod
  // optional — make the agent proactivity-aware, if you want:
  // context: ({ lastRuns, ledger, now }) => `You last ran ${...}`,
}).start("dankre");
```

Eight lines instead of ~320. The run it produces:

```
wake #1  inject: "first wake · goal: keep user briefed · no history"
         agent → LINEAR_LIST_LINEAR_ISSUES (its own tool)      12 open
         agent → send_brief                                    ✔ taken (audit #1)
         reflect: "briefed full backlog · next: 4h"

wake #2  inject: "last wake briefed 12 issues through 14:02"
         agent → LINEAR_LIST_LINEAR_ISSUES                     nothing newer
         agent takes no action
         reflect: "no change · next: 8h — backing off"

wake #3  inject: "…"                                           2 tickets moved
         agent → send_brief (the 2 deltas)                     ✔ taken
         agent → send_brief (hallucinated repeat)              ✖ hard_denied: duplicate
         model reads the denial and stops. restraint, enforced, visible.
```

The adapter contract is deliberately small — `tools()`, `withTools(wrapped)`, `run(context) → transcript` — which is why "works with all" is realistic. LangGraph: trivial, has all three natively. Claude Agent SDK: best fit in the ecosystem — `canUseTool` hooks *are* interception. Raw Anthropic/OpenAI SDK: no agent object exists, so the adapter is an offered loop-runner or the escape hatch (keep your loop, call `governed()` for sends, hand us the messages for reflection). Eve: the serialized-ids hook pattern the repo's own example already proved. ~50–100 lines each, owned by us.

## The primitives are right — that's not the debate

None of this is an argument against the primitives. It's an argument about which layer is the **door**.

The primitives are exactly right for the flows no wrapper can anticipate:

- **Consumers driving their own loop.** The OpenClaw plugin already does this: it imports `createGovernance` standalone and wraps its outbound actions in the same envelope, no heartbeat involved. The core exports it for precisely that reason.
- **Runtimes with hard constraints.** Eve serializes state across step boundaries, so a live `GovernanceHandle` can't survive — the integration rebuilds the envelope from serialized tick ids. No generic wrapper could have guessed that. Only primitives make it possible.
- **Power users with real requirements.** Custom stores (`ProactivityStore` is a public extension point), custom queues (`SchedulerAdapter`), plan/act split loops (`createPlanActHeartbeat`), multi-worker BullMQ scheduling, Python via hermes. These people *want* the pedals — and they're also the users who stress-test the engine and keep it honest.

So the architecture is **two doors into one engine**:

- `proactive()` is the default door — eight lines, agent unchanged, what the README opens with, what 95% of users ever touch.
- The primitives are the machine room — public, documented, and crucially *what the wrapper itself is built from*. `proactive()` compiles down to `createHeartbeat` + `createScheduler` + `createGovernance` + the store. One engine, no fork, no duplicated logic.

This is the shape of every layered SDK that won. LangGraph itself is the cleanest example: `createReactAgent` sits on `StateGraph`/Pregel — nobody starts with Pregel, everybody can drop down to it. Defaults are destiny: whatever the README shows first is what the ecosystem builds with. A primitives-first README selects for the 5% and silently loses the 95%. A wrapper-first README keeps both — because **ejecting isn't migrating**: when the wrapper stops fitting your weird flow, you drop one layer onto the *same* store, same ledger, same scheduler, and your data, audit history, and guarantees come with you.

Do the underlying primitives change? **Essentially no.** The contracts — store schema, scheduler, governance, goal machine, mutation validation — stay exactly as built; the wrapper *needs* them as they are. What's required is additive: a reflection module (prompt + output schema + apply step), a small normalized transcript type for adapters to target, and the adapter packages themselves. Plus two demotions in *positioning*, not code: `sources` stays but is documented as the optional wake-gate; compose-style ticks stay but stop being the front page. The engine was the hard part and it's done. The missing piece is the door.

## The viral thesis

SDK virality selects on **time-to-magic**: seconds from `npm install` to feeling something. The current API's time-to-magic is hours of reading; a 320-line integration doesn't screenshot. The wrapper isn't polish on the viral goal — it's its precondition.

The launch artifact already exists: commit 1 is a normal agent, commit 2 is +8 lines, and a terminal GIF of the loop breathing. The moment that carries it is **wake #2** — everyone has seen an agent act; nobody has seen one visibly *decline* to act, explain why, and back off. Restraint is the demo. Governance is the headline, because the #1 fear of proactive agents is spam: *"it cannot nag you twice — not as a prompt, as a database constraint."* Positioning is Switzerland: cron is a clock with amnesia, Temporal is durability without judgment, memory SDKs are state without a clock — we're the loop with all three, layered over *your* framework. So the ✅-matrix (LangGraph, Claude Agent SDK, OpenAI Agents, Mastra, Eve, raw SDKs) is the funnel, each adapter is a tutorial that writes itself, and the launch essay is this argument — "stop writing judgment in TypeScript" starts fights, and fights are distribution.

---

**In three sentences:** the engine is right and survives whole — primitives stay as the power-user door and the wrapper's own substrate. Sources are the deep flaw — they put runtime judgment into deploy-time code, and for most production signals (absence, state-only, high-volume, backward-pointing relevance, cross-wake patterns) not even dump-the-delta can be coded. The fix is one wrapper — inject, intercept, reflect, schedule — that makes any existing agent proactive in under ten lines as the *default* door, with restraint-by-construction as the story that sells it.
