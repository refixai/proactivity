// The ambient tick context that lets governed() work without restructuring.
//
// proactive() runs the adapter inside AsyncLocalStorage carrying this scope;
// a tool wrapped with governed() picks it up at call time and dispatches
// through the governance envelope. Called outside a wake — the same agent
// serving normal reactive traffic — there is no scope, and governed tools
// pass straight through. That's the whole trick: per-wake attribution flows
// to the tool without the tool (or the agent) ever being handed a handle.
//
// Known limit, by design: AsyncLocalStorage lives and dies with the process.
// Durable-workflow runtimes that serialize state across step boundaries (Eve)
// can't carry it — they use the rebuild-from-ids pattern in the eve subpath
// instead.

import { AsyncLocalStorage } from "node:async_hooks";
import type { GovernanceHandle } from "../core/types.js";
import type { ProactiveEvent } from "./types.js";

export type TickScope = {
  entityId: string;
  tickId: string;
  // Attribution for governed actions: the wake's primary goal and its
  // goal-tick. proactive() points these at the highest-priority active goal.
  goalId: string;
  goalTickId: string;
  governance: GovernanceHandle;
  // The wake's observer, so scope-aware helpers (governedPerform) can narrate
  // without the adapter's involvement. Optional: rebuilt scopes (Eve) and
  // hand-rolled primitive setups may not carry one.
  observe?: (event: ProactiveEvent) => void;
};

const storage = new AsyncLocalStorage<TickScope>();

export const runInTickScope = <T>(scope: TickScope, fn: () => Promise<T>): Promise<T> =>
  storage.run(scope, fn);

export const currentTickScope = (): TickScope | undefined => storage.getStore();
