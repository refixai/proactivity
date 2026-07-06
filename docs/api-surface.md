# API surface — running reference

> Working doc for the future Mintlify docs. Kept current as the surface
> changes; every override point, escape hatch, and invariant belongs here.
> Style note for docs day: config is grouped by subsystem and verbosely named
> on purpose (a 2026-07 naming pass) — don't abbreviate it back.

## The one call

```ts
const handle = proactive(adapter, config)
```

Each wake: **INJECT** (render situation report from the store) → **RUN** (the
unchanged agent, inside a tick scope governed tools attach to) → **REFLECT**
(the dev's model turns the transcript into ledger + goal updates + next wake
time) → **SCHEDULE** (re-arm at the reflected cadence).

## Adapters (first argument)

| Adapter | Subpath | One line |
|---|---|---|
| `fromLangGraph(graph, opts?)` | `/langgraph` | Invokes any `invoke()`-able graph; LangChain callbacks record the transcript live; `runName: "proactive-wake"` labels traces. |
| `fromAnthropic({ client, run })` | `/anthropic` | Hands your hand-rolled loop a traced client (same surface); every `messages.create` through it is recorded. |
| `anthropicLoop({ client, tools, system, … })` | `/anthropic` | No loop yet? The SDK runs a minimal tool-use loop for you. |
| `createEveProactivity(config)` | `/eve` | Hook/tool factories for the Eve durable-workflow runtime (no `proactive()` call; different runtime grain, same store + reflection). |
| custom | — | `{ name, run(input) => Promise<Transcript> }` — three concerns, nothing else. |

`run()` receives `AgentRunInput`: `message` (rendered report), `context`
(full `WakeContext`), `custom` (the `agentInput` callback's output, when
configured), `observe` (call per event → live narration).

## Config (second argument)

| Key | Default | What it does |
|---|---|---|
| `reflection.model` | **required** | The dev's LLM behind `{ generate(prompt, jsonSchema) }`. Helpers: `anthropicModel(client, id)`, `langchainModel(chatModel)`. Powers reflection AND the ledger fold. |
| `reflection.instructions` | none | `{ goals?, scheduling?, ledger? }` free-text appended into the matching default-prompt sections. |
| `reflection.prompt` | built-in | Full **prompt** takeover `(ReflectPromptContext) => string`; output schema still enforced. |
| `reflection.run` | built-in single call | Full **step** takeover `(ReflectionRunContext) => Promise<unknown>` — the deep-reasoning hatch (sub-agent, store reads, every-Nth-wake deep pass). Gets `store`, `defaultPrompt`, `schema` + everything the prompt builder gets. Output still validated/clamped/shielded; a throw degrades like a failed model call. Precedence: `run` > `prompt` > default. |
| `goals` | one pinned fallback (`proactive-loop`) | Seeds, idempotent on stable ids (slug of title if no `id`). `pinned` persists on the record and reconciles if config changes it. |
| `cadence` | min `15m`, max `24h`, default = min | Hard bounds; reflection picks inside them. `"30s"`/`"1.5h"`-style strings or ms numbers. |
| `store` | in-memory (`createTestStore`) | `ProactivityStore` — swap `createPostgresStore({ connectionString | pool })` in prod. This interface is also the managed-platform seam. |
| `schedule` | in-process timer | `SchedulerAdapter` — swap BullMQ for durable/distributed firing. |
| `governance.maxActionsPerWake` | 10 | Ceiling on governed actions that may RUN per wake; excess dispatches hard-deny. |
| `shouldWake` | none | `(ctx: ShouldWakeContext) => boolean \| Promise<boolean>` — the ONLY pre-model hook; may only answer "worth waking the model at all?" (cost control). False → tick recorded, wake skipped, clock re-arms at `cadence.default`. |
| `agentInput` | report as user message | `(ctx: WakeContext) => TCustom` — the statefulness dial. When set, its return value is handed to the adapter INSTEAD of the default message; `ctx.report` still carries the rendered report to embed. |
| `report.recentWakes` | 5 | Past wakes shown verbatim in the report. |
| `report.summarizeOlderWakes` | false | Long-term memory: post-wake, fold newly aged-out wakes into a rolling AI summary (one `reflection.model` call); report gains an "Older wakes (rolling summary)" section. Incremental via `ledgerSummaryThroughTick`; batch-capped (25/wake) so old entities catch up gradually; failed folds → `onError`, marker unadvanced, next wake retries. |
| `observe` | console narrator | Omit = loud narration; fn = raw `ProactiveEvent` stream into your logger; `false` = silent. Throwing observers are swallowed. |
| `onError` | `console.error` | Infra errors: background scheduled-wake failures + ledger-fold failures. The tick records its own failures itself. |

## The handle

| Method | One line |
|---|---|
| `start(entityId)` | Arm the loop; first wake after `cadence.default`. |
| `wake(entityId)` | Immediate wake (webhook entry point). Never resurrects a stopped loop (a stopped entity gets exactly this one look, no re-arm). |
| `stop(entityId)` | Flip `enabled` in the store — authoritative across replicas. |
| `resume()` | Re-arm every should-be-running entity after a process restart (durable store). |
| `addGoal(entityId, goal, { wake? })` | Runtime goal creation — idempotent on the stable id; may pin; `wake: true` also triggers an immediate look. Ensures the entity state row exists (works before first `start`). |
| `completeGoal(entityId, goalId, reason?)` | Dev authority: works on pinned goals (the pinned shield binds reflection, not the developer); throws on unknown/foreign/already-terminal goals. |
| `listGoals(entityId, filter?)` | Store passthrough. |
| `store` | The live store — dashboards, custom queries; ejecting to primitives is not a migration. |

Eve's integration handle mirrors `addGoal`/`completeGoal`/`listGoals`
(entity fixed at config); `wakeNext: true` marks the entity due so the next
cron firing is a real wake (Eve has no in-process scheduler to poke).

## The situation report (INJECT)

Audience: **the developer's agent** (reflection gets its own prompt). Injected
as the opening user message by default; reshaped/replaced via `agentInput`.
Deliberately judgment-free — what matters is the agent's call. Sections:

1. Header — wake #, entity, now, last wake + ago (or "first wake"), manual-trigger note.
2. Standing goals — status/priority, objective, done-condition, `findings` scratchpad.
3. Recent wakes (newest first) — each wake's ledger summary, every governed action `target → outcome`, next-wake reasoning.
4. Older wakes (rolling summary) — only when `summarizeOlderWakes` produced one.
5. How to proceed — fixed behavioral contract: woke on own initiative, acting optional, deliberate nothing is a good wake, never repeat a ledger-shown action unless something changed. (Fixed text; full replacement possible only via `agentInput`.)

## Reflection (REFLECT)

Default: **one** structured-output call on `reflection.model`, no tools.
Prompt input: goal portfolio (with scratchpads + `[PINNED]` tags), rendered
transcript (per-item truncation: args 600 / results 1.5k / model text 2k
chars; whole-transcript 24k budget keeping the TAIL; every cut marked
in-text), three "how to think" sections with `instructions` appended, cadence
bounds in minutes.

Output schema (`REFLECT_OUTPUT_SCHEMA`): `ledgerEntry` (one paragraph for the
future self), `goalMutations[]` (`create/update/reprioritize/pause/complete/
archive`, `findings` = full-replacement scratchpad), `nextWakeMinutes`,
`nextWakeReasoning`.

Output is treated as hostile: schema enforced provider-side + re-validated;
cadence clamped to bounds; pinned goals shielded (only update/reprioritize
survive; `status` stripped; `pinned` is never copied from model output);
invalid mutations dropped individually with warnings; a failed call/override
degrades to defaults with the reason written into the ledger entry — never
fails the wake. `acted` derives from the audit trail, not the model's claim.

## Governance

Opt-in per tool: `governed(tool, opts?)` (LangChain), `governedPerform({...})`
(hand-rolled loops), `governedTool(...)` (Eve). Idempotency key =
actionType + target + tick, claimed BEFORE the effect. Outcomes: `taken`,
`hard_denied` (terminal), `soft_cap_denied` (retriable with `overrideReason`),
`soft_cap_overridden`, `pending_approval`. Denials return in-band via
`describeGovernanceOutcome` so the model re-plans. Outside a wake: transparent
passthrough (`governed: false`).

## Storage (what lives where)

| Table (postgres) | Holds |
|---|---|
| `proactivity_state` | `enabled`, `lastTickAt`, `nextScheduledTickAt`, `ledgerSummary`, `ledgerSummaryThroughTick`. |
| `proactivity_ticks` | Wake rows: number, trigger, status, timestamps, counts, `cadenceHintMs` + `cadenceReasoning`, error. |
| `proactivity_goals` | title/objective/doneCondition, `findings` scratchpad, nextActions, creationReasoning, status, priority, **pinned**, lastWorkedAt. |
| `proactivity_goal_ticks` | wake↔goal join: `acted` + `summary` (reflection's ledger entry). |
| `proactivity_attempts` | The audit trail: actionType, idempotencyKey, outcome, reasoning, denial/override reason, target, payload, error. |

The "ledger" is a composed view over ticks + goal_ticks + attempts (no ledger
table). `applyGoalMutations` is keyed by **entityId** so goals mutate outside
wakes too. Migrations are named + idempotent (`001_initial`,
`002_pinned_and_ledger_summary`); `store.migrate()` applies pending ones.

Positioning note (OSS + managed platform): the SDK owns WHAT is stored; the
`ProactivityStore` interface decides WHERE. The managed product is a hosted
store + scheduler behind the same interface (`store: refixCloud({ apiKey })`
someday) plus a dashboard over the same tables — zero code change to adopt.

## Observability

`ProactiveEvent` stream: `wake_started → agent_event* (live) → governance* →
reflection → wake_completed`, plus `wake_skipped` / `wake_failed`. Default
`consoleNarrator` prints `[proactive:entity]` lines (⚙ tool, 💭 thinking,
✔/⛔ governance, ✎ ledger + goal ops + next wake, absolute done-line time).
Custom observers get unclipped raw events. LangSmith: langgraph traces via
env vars alone; anthropic via `wrapAnthropic` + `traceable` in app code.

## Invariants (deliberately NOT configurable)

- Reflection always runs; its output schema, clamping, and pinned shield.
- `pinned` can never be set by reflection output (dev-only: seeds, addGoal).
- Idempotency claimed before effects; `acted` derived from the audit trail.
- The report carries no judgment; `shouldWake` may only skip, never pre-digest.
- Observers and the ledger fold can never fail a wake.

## Designed, not built (docs-day candidates)

- Transcript compression: when over the 24k budget, compress with
  `reflection.model` instead of chopping (opt-in — costs a call). Today:
  tail-keeping truncation with explicit markers.
- LangSmith polish: `langchainModel` could pass `runName: "proactive-reflection"`
  + entity/tick metadata so reflection runs aren't anonymous `ChatAnthropic` roots.
- Reflection prompt nit: tell it not to restate timestamps/wake numbers in
  ledger entries (the tick row records those).
- `report.instructions` — override the "How to proceed" closing text without
  taking over the whole message via `agentInput`.

## Consumer example

`../linear-brief-agent` (separate repo): two agents (LangGraph + raw
Anthropic SDK) wrapped by `proactive()`, Composio Linear tools, governed
`send_brief`, LangSmith wiring; `manual-primitives` branch shows the same
build on raw primitives. Uses a packed tarball of this repo until the wrapper
publishes.
