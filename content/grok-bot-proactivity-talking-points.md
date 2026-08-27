# Making Grok Bot proactive

Talking points for a content piece on baking `@refix/proactivity` into Grok Bot.

**Status:** draft brief, not product docs. Sources checked 27 Aug 2026.

**Audience:** people who already find Grok Bot impressive as a teammate, and anyone building unattended agents who needs the difference between “runs on a schedule” and “runs itself.”

**Thesis:** Grok Bot gave agents a computer, a roster, and a clock. This repository is the missing envelope: a wake the Bot can reason about, memory that survives hundreds of those wakes, a pace the Bot sets itself, and side effects that cannot double-fire after a crash. Do not wrap Grok Bot in another framework. Layer this onto the loop it already owns, the same way the repo already layers onto OpenClaw, Hermes, and Eve.

---

## 1. One-liners

Pick one. Do not stack them.

- A Grok Bot routine is a cron job with a personality. Proactivity is a teammate that sets its own pace.
- Grok Bot gave agents a computer. This repo gives them a clock they can reason about, a memory that survives wake #500, and a seatbelt on every send.
- Don’t wrap Grok Bot. Layer the envelope on the loop it already owns.
- What’s new is a fact. What matters is a judgment. The report carries facts; the Bot decides.
- Idempotency that lives in a prompt does not survive a crash.
- Grok Bot’s own docs already say: make retries idempotent, and keep sending behind approval. This repo makes those two sentences infrastructure.

---

## 2. What Grok Bot actually is (quote their site, not our spin)

Grok Bot launched in beta on 11 Aug 2026 ([Introducing Grok Bot](https://x.ai/news/introducing-grok-bot)). Access expanded on 26 Aug 2026 to all SuperGrok, Cursor Pro, and Cursor Teams plans ([more plans](https://x.ai/news/grok-bot-more-plans)).

From [docs.x.ai/grok-bot/overview](https://docs.x.ai/grok-bot/overview), a Bot is a named, persistent teammate that:

1. **Has a computer of its own.** A persistent cloud VM with browser, filesystem, and terminal. Connectors/MCP where they exist; computer-use where they don’t. Work finishes in the real tool, not as a chat draft.
2. **Is easy to start.** Message it. No workflow builder required. Same thread on desktop and iOS.
3. **Coordinates with other Bots.** Multiple Bots share one user-scoped computer, message each other, sit in group chats (2–6 Bots), and pass ownership so the human is not the router.
4. **Learns workflows from demonstration.** Follow-along becomes a skill, then a routine that can run on a schedule or on demand.
5. **Keeps durable state.** Memory, files, browser sessions, preferences. Context compounds instead of resetting.

The product pitch that matters for this piece, from the launch post:

> Over time they become more proactive, picking up work before you need to ask and knowing when something needs your attention.

That sentence is the opening. The rest of the piece is: *what has to be true for that to be safe.*

### What “proactive” means on their site today

Not a primitive. Three product surfaces:

| Surface | What it is | Clock |
|---|---|---|
| **Skill** | Reusable instructions: when to use, inputs, sequence, validation, output, approval boundary | None. A method. |
| **Routine** | Tells one Bot when to run a workflow | Fixed schedule **or** a Cursor-integration event (Slack message, GitHub notification) |
| **Approval / Auto-review** | Consequential actions stop for a human; Auto-review is model-based and complementary to least privilege | Human, or a saved Always-allow rule |

Their recommended path ([use cases](https://docs.x.ai/grok-bot/use-cases), [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)):

1. One real task, read-and-prepare first.
2. Correct until the result is reviewable.
3. Save the method as a skill.
4. Test on a second input.
5. Create a routine only when retries and failure cases are defined.
6. Keep sending, purchasing, deleting, publishing, and production changes behind approval.

That is a very good onboarding ladder. It is still a **human-authored timer** plus a **procedure**. The Bot does not decide when to look again. It does not carry a structured mission across wakes. “Don’t double-send” is a design guideline, not a store constraint.

### Constraints the piece should not skip

These are from Grok Bot’s own docs, and they help the trust argument:

- **One computer per user, not per Bot.** Files, cookies, and logins are shared. “Do not use separate Bots as a security boundary.” Screens are work surfaces, not isolation.
- **A Bot may own 50 routines.** The app keeps the **20 most recent run records** per routine.
- **Background routines can pause** after a long time away if the human doesn’t confirm they should keep running.
- **Event listeners should be narrow.** “Every new message” burns usage and acts on noise.
- **Grok Bot requires data storage** and does not support Legacy Privacy Mode.
- **Plugins in the Grok Bot app** are connectors and packaged skills (Marketplace / Yours). Grok Bot follows Cursor plugin and MCP policy; there are no separate Grok Bot plugin controls.
- **Grok Build’s plugin format** (skills, hooks, MCP, `plugin.json`) is a related but distinct surface. Do not claim a Grok Bot hook API that Grok Build has unless we have verified it on Grok Bot itself.

---

## 3. What this repo means by “proactive”

`@refix/proactivity` (this repository) is a TypeScript SDK: durable wake scheduling, cross-wake goal memory, LLM-driven cadence, and idempotent action governance. It works with LangGraph, the Anthropic SDK, Eve, OpenClaw, and Hermes — or any loop you own.

The problem statement from the README, which should stay close to this wording:

> LangGraph, CrewAI, and friends give you a reasoning loop: you call it, it thinks, it returns. That's a reactive agent. A proactive one wakes on its own, notices what changed, pursues goals across wakes, and sets its own pace.
>
> The moment an agent runs unsupervised, you need guardrails or you rebuild them one incident at a time: idempotency after the first double-post, rate caps after the first runaway loop, crash recovery after the first lost job, an audit trail after the first "what did it do?"

Four primitives, compiled into `proactive()` or layered on as a plugin:

1. **Scheduler** — the clock. Wakes the agent; after each wake, re-arms for the next one. This is the piece that makes the agent proactive instead of waiting for a request.
2. **Heartbeat / wake** — one tick. Gather a briefing, load goals, run the agent, govern side effects, return “wake me again in N minutes.”
3. **Goal store** — durable missions with a living scratchpad, so the agent pursues work it set earlier instead of starting from nothing.
4. **Governance envelope** — every side effect (email, Slack, CRM write) passes through idempotency, caps, and an audit trail. Governance never starts anything. The scheduler and heartbeat do.

Every wake has four moments:

```
Inject → Run → Reflect → Schedule
```

| Moment | What happens |
|---|---|
| **Inject** | Situation report from the store: standing goals + scratchpads, recent wakes, actions already taken. Judgment-free. Facts in; judgment stays with the agent. |
| **Run** | The unchanged agent executes. Tools wrapped with `governed()` go through the envelope; reads pass through. |
| **Reflect** | One structured-output call on *your* model writes the ledger entry, evolves each goal’s scratchpad, and picks the next wake time. Always on. A failed reflection degrades to safe defaults instead of failing the wake. |
| **Schedule** | The scheduler re-arms at the reflected cadence, clamped to `{ min, max }`. |

The behavioral contract injected every wake (do not paraphrase this away):

> You woke on your own initiative. Acting is optional — a **deliberate nothing is a good wake**.
> Never repeat an action the ledger already shows as taken unless something has materially changed.

That last line is the opposite of a Bot that “helpfully” re-posts the same watch list every weekday at 8:00.

---

## 4. The gap (use this table in the piece)

| Need for unattended work | Grok Bot today | This repo |
|---|---|---|
| Persistent computer, real tools | Yes. Shared cloud VM, connectors, computer-use. | Out of scope. We are not a runtime. |
| Repeatable method | Skill | Out of scope. We are not a prompt library. |
| A clock | Routine: fixed cron **or** a narrow event | Scheduler: the agent picks the next wake inside `{ min, max }` |
| Event-driven look | Cursor integrations (Slack, GitHub) start a routine | `handle.wake(entityId)` — then reflection re-arms cadence |
| Standing mission | Bot description + conversation memory | Goal objects with objective, done-condition, priority, pinned shield, `findings` scratchpad |
| Memory across 100s of runs | Bot memory; 20 routine-run records | Ledger + scratchpads + optional rolling summary so wake #500 still knows what wake #3 promised |
| Silence is valid | Implicit (you can tell it not to contact customers) | Explicit in the wake report |
| Don’t double-send | Design guideline: “Make retries idempotent where possible.” Auto-review is model-based. | Idempotency key claimed **before** the side effect. Crash-safe. Prompt instructions are not. |
| Action ceiling | Product usage limits | Per-wake / per-tick hard caps; soft caps with in-band denial so the model replans |
| Human approval | Approval cards + Auto-review + “Always allow” | `pending_approval` dry-run. **Compose with** Grok Bot approvals; do not replace them. |
| Whether it “acted” | Transcript + 20 run records | Derived from the audit trail, not from what the model claims |
| Cost control before a model call | Broad listeners are discouraged | `shouldWake`: cheap “is this worth a model call?” Never “what matters.” |
| Crash / restart | Recover / reset computer; durable workspace | `handle.resume()` re-arms every enabled entity from the store |
| Multi-agent | Group chat, DM handoff, shared computer | Plan/act heartbeat: planner mutates goals, executor works one goal. Same store. |

The punchline: Grok Bot is an outstanding **host**. This repo is the **unattended loop**. They fit because this repo already has two integration shapes, and Grok Bot is the second one.

---

## 5. Don’t wrap Grok Bot. Layer the envelope.

This is the architectural talking point. Get it wrong and the piece sounds like “rewrite Grok Bot in LangGraph.”

This repo has two ways in:

| Shape | Who owns the loop | Who this is for | Examples in-repo |
|---|---|---|---|
| **Adapter** | `proactive()` owns inject → run → reflect → schedule | You run the agent process | LangGraph, Anthropic SDK, any `{ name, run() }` |
| **Plugin** | The **host** already owns sessions and scheduling. No `proactive()` call. Governance, goals, and cadence are wired through the host’s hooks, tools, and middleware. | Personal-agent / durable-workflow runtimes | OpenClaw, Hermes, Eve |

Grok Bot is a plugin-shaped host. It already owns:

- the conversation
- the computer
- skills
- routines (the clock)
- event triggers
- approval cards
- Bot-to-Bot handoff

That is the same grain as Eve (static cron + due-gate), OpenClaw (`set_cadence` rides `openclaw cron`), and Hermes (`set_cadence` rides `hermes cron`).

**Say this out loud:** cadence on those plugins is not first-class Refix infrastructure. It *rides the host’s scheduler*, with honest limitations documented in-repo. A Grok Bot integration should say the same thing on day one: cadence rides routines (or a due-gate over a frequent routine), not a hidden BullMQ inside the Bot.

---

## 6. Four bake-in paths, ranked

Ship in this order. The piece can present 1 as “you can do this today,” 2 as “the product-shaped integration,” and 3 as “the Eve analog if routines stay static.”

### Path 1 — Skill + workspace ledger (no new code, weak but real)

A skill that encodes the wake contract:

- Read `/workspace/proactivity/` (goals, last ledger, last actions).
- Do the job.
- Write what you observed, did, and skipped.
- Stay silent unless a human is needed.
- Propose the next look (sooner if something moved, later if quiet).

A weekday routine is the clock.

**Use in the piece as:** the existence proof that Grok Bot users are already reaching for this, and why it fails. A JSON file in `/workspace` is not crash-safe idempotency. A Bot that “tries not to double-post” will double-post the first time the computer recovers mid-send. Grok Bot keeps 20 run records; this repo keeps the attempt trail.

### Path 2 — MCP / packaged plugin on the Bot computer (the OpenClaw analog)

Grok Bot already prefers connectors over clicking through a website. Plugins in the app are connectors and packaged skills. MCP is how Cursor-flavored tools attach.

Expose the same three tools the OpenClaw and Hermes plugins already ship:

| Tool | Job |
|---|---|
| `goal` | Create / update / list / complete durable missions. Pinned goals cannot be closed by the model. |
| `briefing` | Situation report: goals + scratchpads + recent wakes + actions already taken. |
| `set_cadence` | (Re)schedule the next proactive tick by updating the owning routine, or by marking the entity due for the next cron fire. |

Plus interception, not name-shadowing:

- The Bot keeps calling Slack / Gmail / CRM the way it does today.
- Named outbound tools route through `governed()` / `governedPerform()`.
- Denials come back **in-band** (`taken`, `hard_denied`, `soft_cap_denied`, `pending_approval`) so the Bot replans instead of retrying blindly.

Store on the shared computer (`/workspace/proactivity.sqlite` or JSON), matching OpenClaw’s `~/.openclaw/proactivity.json` and Hermes’s `~/.hermes/proactivity.db`. Promote to Postgres when this is a product, not a personal Bot.

**Honest limitation to state in the piece:** a workspace plugin on OpenClaw cannot call the native `scheduleSessionTurn` (hard-gated to bundled plugins), so `set_cadence` shells out to `openclaw cron add`. Expect the same class of constraint on Grok Bot: we will ride routines until there is a first-class third-party scheduling primitive. Document it the way `integrations/openclaw/README.md` already does.

### Path 3 — Eve-style due-gate over a frequent routine (most realistic if routines stay fixed)

Eve already owns cron. This repo does not replace it. It adds a **due-gate**: the host fires often; `get_briefing` returns `{ due: false }` and the agent stops; when due, it is a real wake; `finish_heartbeat` runs reflection and sets the next due time.

Map 1:1 onto Grok Bot:

- A routine every 15 minutes (or whatever `cadence.min` is) is Eve’s static cron.
- Most firings are no-ops: cheap, no “acted,” no Slack post.
- Reflection’s `nextWakeMinutes` is the due-gate, not a new scheduler product.
- `shouldWake` is the pre-model skip when even the briefing is not worth a call (source down, no events since `lastWakeAt`).

This is the path that does not require Grok Bot to let a Bot rewrite its own cron after every run.

Event-driven routines (Slack `#customer-escalations` contains “needs repro”) map to `handle.wake()`. After that look, reflection re-arms — you do not stay at maximum frequency just because one webhook arrived. Grok Bot’s own docs already warn against broad listeners; this is how you keep that warning mechanical.

### Path 4 — Do not do this: `proactive()` wrapping Grok Bot as if it were LangGraph

Grok Bot is not a `run()` you call. It is the process. Forcing the adapter shape means you now own a second clock, a second store, and a fight with routines. The in-repo FAQ already explains why Eve does not use `proactive()`: the host owns sessions and scheduling. Same answer for Grok Bot.

---

## 7. Map Grok Bot surfaces onto the four wake moments

This is the “how it actually fits” diagram for a blog or talk.

```
Grok Bot routine fires  (or a Slack/GitHub event, or a DM from another Bot)
        │
        ▼
 Inject     briefing tool / skill reads goals + ledger from /workspace
        │   (Grok Bot memory is still there — this is structured mission memory on top)
        ▼
 Run        unchanged Bot: connectors, computer-use, group handoff
        │   outbound tools go through governance
        │   Grok Bot approval cards still sit in front of send / purchase / publish
        ▼
 Reflect    one structured call: ledger paragraph, scratchpad updates, nextWakeMinutes
        │   acted := audit rows, not the Bot’s self-report
        ▼
 Schedule   set_cadence updates the routine  —or—  due-gate for the next 15m cron
```

### Approvals: compose, don’t compete

Grok Bot’s approval story is the right human boundary. This repo’s governance is the machine boundary *in front of* that card.

| Layer | Who | What it stops |
|---|---|---|
| Governance envelope | Store + caps | Double-send after crash, runaway loop, “I already did this this wake” |
| Dry-run `pending_approval` | Store | Lets you preview the same volume live mode would allow, because drafts still consume cap budget |
| Grok Bot approval card | Human | Send, purchase, delete, publish, production change |
| Auto-review | Model-based rules | Complementary. Their docs say it should not replace least privilege. We agree. |

A strong line: **Auto-review is a model. Idempotency is a row in a table claimed before the send.** Use both.

### Multi-Bot: plan/act, with a security caveat

Grok Bot’s group chat and DM handoff are the product version of this repo’s optional plan/act heartbeat:

- **Chief of Staff Bot** = planner. Mutates the goal portfolio, picks what to work, sets cadence.
- **Specialist Bots** (Talent Scout, Expense Manager, Bug Reproduction) = executors. One goal at a time, every side effect through governance.
- **Shared computer** = shared store. That is why handoff works without pasting notes.

Then the caveat, in their words: separate Bots are **not** a security boundary. Governance has to sit on the computer, not “inside the good Bot.” Otherwise the specialist that got the shared Gmail session is the one that double-sends.

### Memory: two systems, don’t collapse them

Grok Bot already remembers preferences, voice, and “how you like work done.” Keep that.

This repo adds **mission memory**:

- Per-goal `findings` scratchpad (what to do next on this watch).
- Per-wake ledger entry (what happened, what was deliberately skipped).
- Optional rolling summary so long-lived Bots do not forget wake #3 at wake #500.

Hermes’s README already says this cleanly: goals complement `MEMORY.md` (facts) and Skills (procedures); they don’t replace them. Same sentence works for Grok Bot.

Grok Bot’s 20 routine-run records are operational history, not this.

---

## 8. Flagship demo (write the piece around one job)

Use **Account Health** or **Sales outbound**. Both are first-party Grok Bot use cases. Both currently end as “create a nightly / weekday routine that stops at a review list.”

### As Grok Bot ships it

> Every weekday at 8:00 AM, run Daily customer-risk against the current account list. Post a linked watch list in this conversation. Do not contact customers. If the source data is unavailable, report the failure instead of using old data.

That is a good routine. It is also the same cost and the same noise every quiet week.

### With this repo on that same Bot

Standing **pinned** goal (the model cannot close it; only the human can):

> Each wake, check the portfolio against what previous wakes reported. Post a watch list when something needs a human: usage cliff on a renewal account, a new escalation, a stakeholder going dark. Stay silent otherwise.

Cadence `{ min: "15m", max: "24h" }`.

Two wakes, four hours apart — reuse the README narrator, swapped onto Account Health:

```
wake #1 (scheduled) — quiet portfolio, nothing new — next wake in 4h
        ····· four hours later ·····
wake #2 (scheduled) — usage cliff on Northwind, renewal in 12 days
        post_to_conversation — taken
        next wake in 30m (watch for movement)
```

Wake 1 is a **deliberate nothing**. Wake 2 tightens because something moved. A third wake that sees the same Northwind cliff already in the ledger does **not** post again (`hard_denied` / “already taken”). A crash after the key is claimed does **not** double-post on recover.

Event path: a Slack message in `#customer-escalations` with “needs repro” is `handle.wake()`, not a second always-on listener that fires on every message.

That demo is the whole piece. The rest is why the quiet wake was correct.

Other Grok Bot jobs that map the same way (from [Jobs Bots are doing today](https://x.ai/news/grok-bot-more-plans)):

- **Inbox manager** — back off when the inbox is clean; tighten when a VIP thread lands; never send the same nudge twice.
- **Pipeline ops** — Monday scoreboard is a routine; stall detection is cadence.
- **Digital declutterer** — around-the-clock is the pitch; caps + dry-run are how it doesn’t unsubscribe you from payroll.
- **Customer support / refunds** — policy-bounded actions through governance; Grok Bot approval still in front of the refund.

---

## 9. Trust argument (quote them, then show the mechanical version)

Grok Bot’s [design routines for trust](https://docs.x.ai/grok-bot/skills-routines-and-automations) already lists:

- Automate preparation before execution.
- Draft, reconcile, or recommend first.
- Require approval for sending, purchasing, deleting, publishing, or changing production.
- Include a no-data and stale-data policy.
- **Make retries idempotent where possible.**
- Tell the Bot where to report partial completion.
- Re-test after a website, connector, or source format changes.

This repo is those bullets as code:

| Their guideline | Mechanical version here |
|---|---|
| Prepare before execute | Inject a judgment-free report; `shouldWake` can skip the model entirely |
| Draft first | Dry-run: every action recorded as `pending_approval`, still consuming cap budget so the preview is honest |
| Approval for send/spend/publish | Leave Grok Bot’s cards in place; govern before the card |
| No-data / stale-data | Briefing sources with `deltaCutoff`; stale policy belongs in the goal objective |
| Idempotent retries | Key = `actionType + target + tickId`, claimed **before** `perform()` |
| Partial completion | Ledger entry: observed / did / deliberately skipped |
| Re-test after format change | `handle.wake()` after you change the skill; test-run in Grok Bot is still the right product ritual |

Invariants worth naming (they are not missing knobs):

- Reflection **always** runs. Failure degrades; it never skips the ledger.
- `pinned` can never be set by model output.
- Idempotency is claimed before the effect.
- The report carries no judgment (`shouldWake` may only skip, never pre-digest what matters).
- Observers can never fail a wake.

“What’s new is a fact; what matters is a judgment” is the line to keep.

---

## 10. Soundbites and lines that travel

For a talk, pull 4–5. For a thread, one per tweet.

1. Most agents are functions. Grok Bot made them colleagues. Colleagues still need a shift schedule they can change, and a rule that they cannot send the same email twice because the VM recovered.
2. “Runs every weekday at 8am” is automation. “Looked, nothing moved, see you in four hours; something moved, see you in thirty minutes” is proactivity.
3. The expensive mistake is an agent that acts every wake. The wake report says acting is optional on purpose.
4. We did not invent Grok Bot’s trust model. We implemented the two sentences their docs already ask for: idempotent retries, and a stop before send.
5. OpenClaw and Hermes already run this as a plugin with three tools: `goal`, `briefing`, `set_cadence`. Grok Bot is the same shape with a better computer.
6. Cadence on a host we don’t control always *rides* the host’s cron. We say that in the OpenClaw README. We would say it in a Grok Bot README too.
7. Separate Bots are not a security boundary. Governance belongs on the shared computer.
8. Quiet is a feature. A Bot that posts a watch list every morning trains you to ignore it. A Bot that only posts when the ledger says something changed trains you to trust it.
9. Reflection is bookkeeping, not a second personality. Use a cheaper model. The agent keeps the capable one.
10. If you have to wrap Grok Bot in `proactive()`, you are using the wrong layer. Eve taught us that.

---

## 11. Claims to avoid

These will get the piece (or a launch) in trouble.

- **Do not say Grok Bot is not proactive.** Their product is already more unattended than chat-and-wait agents. The claim is: routines are a fixed or evented clock; this repo adds self-pacing, mission memory, and crash-safe governance.
- **Do not say we replace approval cards, Auto-review, or least-privilege accounts.** We sit under them.
- **Do not say separate Bots plus this repo equals isolation.** Grok Bot is explicit: one computer.
- **Do not promise a native Grok Bot scheduler API.** We have not seen one. Ride routines / due-gate, and name the limitation.
- **Do not conflate Grok Build plugins (hooks, `plugin.json`, marketplace SHA pins) with Grok Bot app plugins (connectors + packaged skills).** Related ecosystem, different install path. Verify before a “paste this into your Bot” install blurb.
- **Do not claim we give Grok Bot a computer.** It has one. We are not a VM product.
- **Do not imply reflection is a second Grok.** It is one structured-output call on the customer’s model, truncating the transcript, with hostile-output validation and a pinned shield.
- **Do not present Path 1 (skill + JSON file) as the product.** It is the foil.
- **Do not skip cost.** Every real wake is an agent run + one reflection call. Cadence bounds and `shouldWake` are how a 15-minute due-gate does not become a 15-minute full agent. Grok Bot already warns that broad listeners burn usage.

---

## 12. Suggested shapes for the piece

### Blog (~1,200–1,800 words)

1. Open on the launch line: *over time they become more proactive.*
2. Show the 8am Account Health routine. Respect it.
3. Name the unsupervised failure modes Grok Bot’s own trust list already implies (double-send, runaway, lost job, “what did it do?”).
4. Four moments: inject, run, reflect, schedule.
5. Gap table (short form).
6. “Don’t wrap it” + OpenClaw/Hermes/Eve as proof this pattern already ships.
7. Demo narrator: quiet wake, then a cliff, then no double-post.
8. Approvals compose; idempotency is a row.
9. Honest limitation: cadence rides routines.
10. Close: the computer was the hard part. The envelope is how you leave it running.

### Thread (8–10 posts)

1. Grok Bot is a teammate with a computer. The remaining problem is unattended time.
2. A routine is cron. Proactivity is self-pacing.
3. Four moments.
4. Quiet wake screenshot / narrator.
5. Busy wake + tighten to 30m.
6. Double-post blocked because the key was claimed before send.
7. Three tools: `goal`, `briefing`, `set_cadence`.
8. We already do this for OpenClaw and Hermes.
9. We do not replace their approval cards.
10. Link the repo.

### Talk (20 min)

- 0–3: two wakes on a slide (quiet / P0).
- 3–8: Grok Bot product tour using *their* use cases, not ours.
- 8–14: primitives + why plugin not adapter (Eve FAQ slide).
- 14–18: governance vs Auto-review vs approval cards (three layers).
- 18–20: bake-in path and the honest cron limitation.

---

## 13. What we would build next (if this brief becomes a PR to the SDK)

Not required for the content piece. Useful if the article’s CTA is “we’re adding a Grok Bot plugin.”

1. **`integrations/grok-bot`** in the same shape as `integrations/openclaw` and `integrations/hermes`: three tools, governance by interception, store on disk, `set_cadence` riding routines or a due-gate.
2. **A skill** (`SKILL.md`) that states the wake contract, approval boundaries, and “deliberate nothing is a good wake,” installable as a packaged skill in Grok Bot’s Marketplace / Yours.
3. **Docs page** under the Plugins tab, with an honest limitations accordion copied from OpenClaw (cadence rides host cron; ticks may be time buckets; fail-open vs fail-closed).
4. **Do not** add a `fromGrokBot()` adapter unless we are running the Bot as a subprocess we own. We are not.

Roadmap already in the README that the piece can mention without over-claiming: more first-class adapters (Vercel AI SDK, OpenAI Agents SDK), pluggable long-term memory behind the scratchpad, cost/token accounting on the event stream, SQLite store for local/edge. A Grok Bot plugin is a host integration, not a new primitive.

---

## Sources

Grok Bot (SpaceXAI), retrieved 27 Aug 2026:

- [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot) (11 Aug 2026)
- [Grok Bot is now included with more plans](https://x.ai/news/grok-bot-more-plans) (26 Aug 2026)
- [Overview](https://docs.x.ai/grok-bot/overview)
- [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Use cases](https://docs.x.ai/grok-bot/use-cases)
- [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications)
- [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [xAI plugin marketplace](https://github.com/xai-org/plugin-marketplace) (Grok Build catalog format; do not treat as Grok Bot app API without verification)

This repository:

- `README.md`, `PRIMITIVES.md`
- `docs/concepts/{architecture,scheduling,governance,reflection,goals,memory,context-injection}.mdx`
- `docs/plugins/{overview,openclaw,hermes,eve}.mdx`
- `docs/guides/{webhook-wakes,cost-control}.mdx`
- `integrations/openclaw/README.md`, `integrations/hermes/README.md`
