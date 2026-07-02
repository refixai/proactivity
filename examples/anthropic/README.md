# Anthropic SDK example — parse, then dispatch

A proactive agent on the Anthropic SDK. Each tick, Claude returns a structured
plan of actions (via structured outputs); the code loops over them and routes
each one through `governance.dispatch`. This "parse, then dispatch" pattern
applies equally to the OpenAI SDK and Mastra — only the model call changes.

The demo runs 3 ticks a few seconds apart: the first tick sees a new signup and
welcomes it (a `console.log` stand-in), the rest go quiet and back off.

## Prerequisites

- Node >= 20
- pnpm
- `ANTHROPIC_API_KEY`

The SDK is linked from the repo root via `file:../..` and must be built first
(`pnpm build` at the root — already done if `dist/` exists).

## Run

```bash
pnpm install
ANTHROPIC_API_KEY=sk-ant-... pnpm start
```
