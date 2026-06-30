# proactivity-hermes

A [Hermes](https://hermes-agent.nousresearch.com) plugin that adds the
[`@refixai/proactivity`](../../) primitives a stock agent lacks:

- Governance envelope: every governed tool call passes through idempotency,
  a per-tick action cap, and pluggable soft caps before it fires, with a full
  audit trail. Point it at the tools your agent actually uses to act on the world
  (a Discord post, a Feishu reply, a custom outbound tool).
- Durable goals: a goal portfolio with lifecycle (active → paused →
  completed → archived) and done-conditions. Complements Hermes's `MEMORY.md`
  (facts) and Skills (procedures); it doesn't replace them.
- Self-adjusting cadence: a `set_cadence` tool that (re)schedules the next
  proactive tick through Hermes's own cron.

Hermes already provides the agent loop, memory, gateways, and scheduler. This
plugin layers governance and goals on top of that machinery; it is an adapter,
not a second framework.

## Install

```bash
pip install proactivity-hermes
hermes plugins enable proactivity
```

Enabling registers three tools (`goal`, `briefing`, `set_cadence`). Naming your
outbound tools in `PROACTIVITY_GOVERNED_TOOLS` additionally wraps them in a
`tool_execution` middleware that routes their calls through the envelope.

## How it works

| Concern | Mechanism |
|---|---|
| New tools | `ctx.register_tool(..., toolset="proactivity")` |
| Govern outbound | `ctx.register_middleware("tool_execution", …)` wrapping the tools in `PROACTIVITY_GOVERNED_TOOLS`: allow = `next_call(args)`, deny = return a denial result, so the agent sees why it was blocked |
| Cadence | `cron.create_job` (the same scheduler `hermes cron` uses) |
| Storage | a private SQLite db at `~/.hermes/proactivity.db` (goals + attempt ledger) |

Governance is **interception, not name-shadowing**: the agent calls a tool it
already has; the middleware routes that call through the envelope transparently.

## Configuration

Set via environment variables (sensible defaults shown):

| Variable | Default | Meaning |
|---|---|---|
| `PROACTIVITY_PER_TICK_CAP` | `5` | Max actions taken per tick before the cap denies further ones |
| `PROACTIVITY_GOVERNED_TOOLS` | _(none)_ | Comma-separated tool names to govern. Empty by default, so governance is opt-in (see Limitations). Set it to your agent's real outbound tools, e.g. `discord`. Warns if a name isn't a registered tool. |
| `PROACTIVITY_TICK_SECONDS` | `60` | Width of a "tick" bucket; the scope of the per-tick cap and idempotency |
| `PROACTIVITY_RECENT_CONTACT_THRESHOLD` | `2` | Soft-cap: hold a send after this many recent contacts to the same recipient |
| `PROACTIVITY_DRY_RUN` | `false` | Record actions as `pending_approval` instead of performing them |
| `PROACTIVITY_ENTITY_ID` | `hermes` | Governance scope (for a single personal agent, leave as-is) |

## Limitations (honest)

- **Cadence is minute-granular.** Hermes's cron ticks on a 60s floor, so
  sub-minute cadence isn't expressible. The SDK's cadence is only first-class on
  infrastructure Refix controls; here it rides Hermes's cron.
- **Ticks are time buckets, not turns.** The per-tick cap and idempotency are
  scoped to a `PROACTIVITY_TICK_SECONDS` window, not to a Hermes session/turn.
  Good enough for a personal agent; upgrade to session-scoped ticks if you need
  exact per-turn semantics.
- **Governance fails open.** If the envelope itself errors, the action proceeds
  (matching Hermes's own middleware posture) rather than muting the agent.
- **Governance is opt-in; you name your outbound tools.** It only fires for
  tools the agent actually calls, and only those you list in
  `PROACTIVITY_GOVERNED_TOOLS` (empty by default, so no tool is wrapped until you
  say so). There's no safe default: stock Hermes deliberately does *not* expose a
  `send_message` tool to the model (a turn's reply is delivered as the response
  itself, not a tool call), and only you know which tool your agent sends through
  (`discord`, `feishu_drive_reply_comment`, a custom tool). The plugin warns at
  the first tool flow if a name you configured isn't a registered tool.

## Develop

```bash
python3 tests/test_governance.py   # governance + store logic, no Hermes needed
# the rest need `pip install hermes-agent` (they skip cleanly without it):
python3 tests/test_plugin_smoke.py # tools + governance via the real tool registry
python3 tests/test_middleware.py   # override, routing, fail-open, real-tool govern, phantom warn, idempotency
python3 tests/test_cron.py         # set_cadence fires AND re-arms via the real scheduler
python3 tests/test_plugin_load.py  # plugin loads through real Hermes + entry point is discoverable
```
