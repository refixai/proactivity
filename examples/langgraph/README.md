# LangGraph example

A self-running LangGraph agent on `@refix/proactivity`. It demonstrates the
**govern the tool** pattern: the model calls tools itself, so each side-effecting
tool wraps `governance.dispatch` — the same pattern applies to the Vercel AI
SDK, Eve, and any framework where the model calls tools.

What it does: a timer scheduler wakes the agent every few seconds; each tick
assembles a briefing (a fake "new signups" source that fires once), creates a
durable goal on the first tick, and hands the prompt to a LangGraph ReAct
agent whose `send_email` tool routes through governance (idempotency, caps,
audit). After 3 ticks it stops itself.

## Prerequisites

- Node >= 20
- pnpm
- An `ANTHROPIC_API_KEY`
- The SDK is linked from the repo root via `file:../..` and must be built
  first (`pnpm build` at the repo root — already done if `dist/` exists).

## Run

```bash
pnpm install
ANTHROPIC_API_KEY=sk-ant-... pnpm start
```
