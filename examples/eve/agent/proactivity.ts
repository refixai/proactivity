// Shared proactivity wiring for the Eve agent.
//
// Eve is filesystem-first: tools, hooks, and schedules each live in their own
// file and can't close over a tick's state the way a LangGraph tool closes over
// `governance`. So the tick's identifiers are stashed in Eve state
// (`defineState`) that any of them read back.
//
// IMPORTANT: Eve is a durable-workflow runtime and serializes `defineState`
// across step boundaries, so state must be plain JSON — you can't stash the
// live `GovernanceHandle` here (its `dispatch` is a function, and functions
// don't serialize). Instead we stash the tick's ids and let the governed tool
// rebuild the envelope from them + the shared `store`. Idempotency (nudge once
// per thread) still holds because it's keyed on `store` + `tickId`, not on the
// in-memory handle.
import { createTestStore } from "@refix/proactivity";
import { defineState } from "eve/context";

// In-memory store for the demo. Because governance is rebuilt per tool call, the
// store is also what carries idempotency + the audit ledger across those calls,
// so it must be shared. createTestStore() is a per-process singleton — fine for
// a single `eve start`; swap it for the postgres adapter
// (@refix/proactivity/postgres) for a real (multi-process / replayed) deploy.
export const store = createTestStore();

export const ENTITY_ID = "eve-demo";

// Governance caps for a tick.
export const CAPS = { perPass: 3, perTick: 10 };

// A conversation you owe a reply to.
export type PendingReply = { threadId: string; who: string };

// What the current tick exposes to the file-based tools — plain JSON only.
// send_followup_nudge reads the ids to rebuild governance; list_pending_replies
// reads pendingReplies.
export type TickContext = {
  tickId: string;
  goalId: string;
  goalTickId: string;
  pendingReplies: PendingReply[];
};

// Per-session state slot. The session.started hook (hooks/open-tick.ts) writes
// it; the tools read it. get()/update() throw outside an active eve context.
export const tickState = defineState<TickContext | null>(
  "proactivity.tick",
  () => null,
);
