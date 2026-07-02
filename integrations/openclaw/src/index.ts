/**
 * @refix/proactivity — OpenClaw plugin entry.
 *
 * Adds a governance envelope over outbound actions, a durable goal portfolio,
 * and a cadence tool. Runs the SDK's *actual* governance in-process (see
 * `runtime.ts`); OpenClaw drives the loop and gateways.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createRuntime, type ProactivityRuntime } from "./runtime.js";

// OpenClaw calls `register()` more than once per process — discovery for the
// capability snapshot, then "full" for each agent lane — all against a single
// module evaluation. A fresh runtime per call would fragment governance: each
// would carry its own in-memory per-tick ledger (so the cap never accumulates)
// over its own JSON-store handle (whose full-file writes clobber the others).
// Memoize one runtime per store path so every registration shares the same
// ledger and store. Keyed by dbPath, the natural identity of a governance scope.
const runtimeByDbPath = new Map<string, ProactivityRuntime>();

export default definePluginEntry({
  id: "proactivity",
  name: "Proactivity",
  description: "Governance envelope, durable goals, and cadence for a proactive OpenClaw agent.",

  register(api) {
    // The plugin's own settings live in `pluginConfig` (from
    // plugins.entries.proactivity.config) — NOT `api.config`, which is the whole
    // OpenClaw config.
    const cfg = api.pluginConfig ?? {};
    const getNum = (k: string, d: number) => (typeof cfg[k] === "number" ? (cfg[k] as number) : d);
    const getStr = (k: string, d: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : d);

    // Default fail-open (match OpenClaw's resilient posture); flip on for deployments
    // that need governance to be a hard gate even when its store is unavailable.
    const failClosed = cfg.failClosed === true;

    const dbPath = getStr("dbPath", join(homedir(), ".openclaw", "proactivity.json"));
    let runtime = runtimeByDbPath.get(dbPath);
    if (!runtime) {
      runtime = createRuntime({
        entityId: getStr("entityId", "openclaw"),
        dbPath,
        perTick: getNum("perTickCap", 5),
        tickSeconds: getNum("tickSeconds", 60),
        recentContactThreshold: getNum("recentContactThreshold", 3),
        dryRun: cfg.dryRun === true,
        sessionKey: typeof cfg.sessionKey === "string" ? (cfg.sessionKey as string) : undefined,
        governedTools: new Set<string>(Array.isArray(cfg.governedTools) ? (cfg.governedTools as string[]) : []),
      });
      runtimeByDbPath.set(dbPath, runtime);
    }

    api.registerTool(runtime.tools.goal);
    api.registerTool(runtime.tools.briefing);
    api.registerTool(runtime.tools.setCadence);

    // Govern all outbound text (proactive sends and replies both flow here).
    api.on("message_sending", async (event: { to: string; content: string }) => {
      try {
        const verdict = await runtime.decide("message", { to: event.to, content: event.content });
        if (!verdict.ok) return { cancel: true, cancelReason: verdict.reason };
      } catch (err) {
        api.logger?.warn?.(`proactivity: governance error, ${failClosed ? "blocking" : "allowing"} send (${(err as Error).message})`);
        if (failClosed) return { cancel: true, cancelReason: "proactivity governance unavailable (fail-closed)" };
      }
      return undefined;
    });

    // Gate only the side-effecting tools the operator opts into (default none) —
    // we don't want to rate-limit read/grep/ls.
    api.on("before_tool_call", async (event: { toolName: string; params: Record<string, unknown> }) => {
      if (!runtime.governedTools.has(event.toolName)) return undefined;
      try {
        const verdict = await runtime.decide(event.toolName, { toolName: event.toolName, params: event.params });
        if (!verdict.ok) return { block: true, blockReason: verdict.reason };
      } catch (err) {
        api.logger?.warn?.(`proactivity: governance error, ${failClosed ? "blocking" : "allowing"} tool (${(err as Error).message})`);
        if (failClosed) return { block: true, blockReason: "proactivity governance unavailable (fail-closed)" };
      }
      return undefined;
    });

    api.logger?.info?.(
      `proactivity registered (entity=${getStr("entityId", "openclaw")}, perTick=${getNum("perTickCap", 5)})`,
    );
  },
});
