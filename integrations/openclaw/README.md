# @refix/proactivity-openclaw

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that adds the
[`@refix/proactivity`](../../) primitives a stock agent lacks:

- Governance envelope: every outbound message (and any tool you opt in)
  passes through idempotency, a per-tick action cap, and pluggable soft caps
  before it fires, with a full audit trail.
- Durable goals: a goal portfolio with lifecycle and done-conditions.
- Cadence: a `set_cadence` tool that schedules the next proactive tick.

Unlike a Python framework, OpenClaw is TypeScript, so this plugin runs the SDK's
actual governance in-process: `createGovernance`/`createLedger` are imported
and reused verbatim rather than reimplemented.

## Install

### Option A — Agent-assisted (recommended)

Tell your OpenClaw agent:

```
Install and enable the proactivity plugin: run `openclaw plugins install npm:@refix/proactivity-openclaw`, then `openclaw plugins enable proactivity`. Confirm both commands succeeded.
```

### Option B — Manual

```bash
openclaw plugins install npm:@refix/proactivity-openclaw
openclaw plugins enable proactivity
```

Either way, it registers three tools (`goal`, `briefing`, `set_cadence`) and two hooks:

| Hook | What it governs |
|---|---|
| `message_sending` | all outbound text: proactive sends and replies. Rewrite or cancel before it reaches Slack/Telegram/etc. |
| `before_tool_call` | only the side-effecting tools you list in `governedTools` (default none, so we don't rate-limit `read`/`grep`/`ls`) |

Governance works by interception, not name-shadowing: the agent calls its native
send; the hook routes it through the envelope and returns a denial the agent can
see if it's blocked.

## Configuration

Under `plugins.entries.proactivity.config` in `openclaw.json`:

| Key | Default | Meaning |
|---|---|---|
| `perTickCap` | `5` | Max actions per tick bucket before the cap denies further ones |
| `governedTools` | `[]` | Extra tool names to gate (outbound messages are always governed) |
| `tickSeconds` | `60` | Width of a tick bucket; scope of the per-tick cap and idempotency |
| `recentContactThreshold` | `3` | Soft-cap: hold a send after this many recent contacts to the same recipient |
| `dryRun` | `false` | Record actions without performing them |
| `failClosed` | `false` | If governance itself errors (e.g. its store is unavailable), block the action instead of letting it through |
| `sessionKey` | none | Session to route proactive cron ticks into |
| `dbPath` | `~/.openclaw/proactivity.json` | JSON store location |

## Limitations (honest)

- **Cadence rides the `openclaw cron` CLI.** A *workspace* plugin can't call
  `scheduleSessionTurn`; it's hard-gated to bundled plugins (returns `undefined`
  for us). So `set_cadence` shells out to `openclaw cron add`; it returns a clear
  error if the CLI isn't reachable. A native scheduling primitive for third-party
  plugins is the one upstream ask.
- **Ticks are time buckets, not turns** (`tickSeconds`): the per-tick cap and
  idempotency are scoped to that window, fine for a personal agent.
- **Governance fails open.** If the envelope errors, the action proceeds
  (matching OpenClaw's resilient posture) rather than muting the agent.

## Develop

```bash
npm install        # links @refix/proactivity from ../.. (build the SDK first)
npm run typecheck  # checks the OpenClaw glue against OpenClaw's real types
npm test           # drives the real governance + tools (no OpenClaw needed)
```
