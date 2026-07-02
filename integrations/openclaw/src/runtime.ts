/**
 * The framework-agnostic core: builds the store, the reused SDK governance, the
 * per-tick handle cache, the `decide` gate, and the three tools — with no
 * dependency on OpenClaw. `index.ts` wires this into OpenClaw's plugin API; the
 * tests drive it directly.
 */

import {
  createGovernance,
  createLedger,
  type GovernanceConfig,
  type GovernanceHandle,
  type ProactivityStore,
  type SoftCap,
} from "@refix/proactivity";
import { createJsonStore } from "./store.js";
import { briefingTool, goalTool, setCadenceTool } from "./tools.js";

export type RuntimeConfig = {
  dbPath: string;
  entityId: string;
  perTick: number;
  tickSeconds: number;
  recentContactThreshold: number;
  dryRun: boolean;
  governedTools: Set<string>;
  sessionKey?: string;
};

export type ProactivityRuntime = {
  store: ProactivityStore;
  governedTools: Set<string>;
  decide: (
    actionType: string,
    target: Record<string, unknown>,
  ) => Promise<{ ok: boolean; reason: string }>;
  tools: {
    goal: ReturnType<typeof goalTool>;
    briefing: ReturnType<typeof briefingTool>;
    setCadence: ReturnType<typeof setCadenceTool>;
  };
};

export const createRuntime = (cfg: RuntimeConfig): ProactivityRuntime => {
  const store = createJsonStore(cfg.dbPath, cfg.entityId);
  void store.migrate();

  const recentContact: SoftCap = {
    name: "recent_contact",
    evaluate: ({ target, recentAttempts }) => {
      const who = (target.to ?? target.toolName) as string | undefined;
      if (who == null) return { triggered: false };
      const prior = recentAttempts.filter((a) => (a.target.to ?? a.target.toolName) === who).length;
      return prior >= cfg.recentContactThreshold
        ? { triggered: true, warning: `Soft cap: already contacted ${who} ${prior}x recently` }
        : { triggered: false };
    },
  };

  const govConfig: GovernanceConfig = {
    store,
    // perPass is the heartbeat's per-goal cap; there are no goal-passes here,
    // so disable it and let perTick be the only ceiling.
    caps: { perTick: cfg.perTick, perPass: Number.MAX_SAFE_INTEGER },
    softCaps: [recentContact],
    dryRun: cfg.dryRun,
  };

  // One governance handle per time-bucket tick; the ledger it holds accumulates
  // the per-tick action count across the independent hook calls in that bucket.
  const govCache = new Map<string, GovernanceHandle>();
  const govFor = (tickId: string): GovernanceHandle => {
    let g = govCache.get(tickId);
    if (!g) {
      g = createGovernance(govConfig, tickId, cfg.entityId, createLedger());
      govCache.set(tickId, g);
      if (govCache.size > 8) {
        for (const k of [...govCache.keys()].slice(0, govCache.size - 8)) govCache.delete(k);
      }
    }
    return g;
  };

  // Gate model: governance decides allow/deny *before* OpenClaw runs the action.
  //
  // OpenClaw fires governance hooks concurrently for parallel tool calls, but a
  // dispatch is a read-modify-write over the shared per-tick ledger and store
  // (check the cap / idempotency, then record). Interleaved dispatches race —
  // two calls each read a count of 0 and both clear a cap of 1. Serialize every
  // decision through a promise chain so each finishes recording before the next
  // one reads.
  let queue: Promise<unknown> = Promise.resolve();
  const decide = (actionType: string, target: Record<string, unknown>) => {
    const run = async () => {
      const tickId = String(Math.floor(Date.now() / 1000 / cfg.tickSeconds));
      const result = await govFor(tickId).dispatch({
        goalId: "_outbound",
        goalTickId: tickId,
        actionType,
        target,
        reasoning: "",
        perform: async () => {},
      });
      const ok =
        result.governanceOutcome === "taken" || result.governanceOutcome === "soft_cap_overridden";
      return { ok, reason: result.denialReason ?? "blocked by proactivity governance" };
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };

  return {
    store,
    governedTools: cfg.governedTools,
    decide,
    tools: {
      goal: goalTool(store),
      briefing: briefingTool(store, cfg.entityId),
      setCadence: setCadenceTool({ sessionKey: cfg.sessionKey }),
    },
  };
};
