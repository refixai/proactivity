// The default observer: a compact console narration of the proactive loop.
//
// A background agent's worst failure mode is silence — "did it even wake?" —
// so proactive() narrates by default. One line per meaningful moment,
// including what the model was thinking (clipped) and, at the end of the
// wake, exactly when the next one lands:
//
//   [proactive:user-1] wake #3 (scheduled) — 1 goal, last wake 2m ago
//   [proactive:user-1] ⚙ LINEAR_LIST_LINEAR_ISSUES {"assignee":"me"}
//   [proactive:user-1] 💭 Two tickets changed since the last brief — worth sending…
//   [proactive:user-1] ✔ send_brief — taken
//   [proactive:user-1] ✎ briefed 2 changed tickets — next wake in 90s (activity is fresh)
//   [proactive:user-1] wake #3 done (acted) — next wake at 1:19:45 AM
//
// Custom observers get the unclipped stream (full model text, full args, the
// reflection's goal mutations); the narrator only decides what a console line
// can carry.

import type { ProactiveEvent } from "./types.js";

const clip = (value: unknown, max: number): string => {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const ago = (from: Date | null, now = new Date()): string => {
  if (!from) return "never";
  const ms = Math.max(0, now.getTime() - from.getTime());
  return `${human(ms)} ago`;
};

const human = (ms: number): string => {
  if (ms <= 90_000) return `${Math.round(ms / 1000)}s`;
  if (ms <= 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
};

export const consoleNarrator = (
  log: (line: string) => void = console.log,
): ((event: ProactiveEvent) => void) => {
  return (event) => {
    const tag = `[proactive:${event.entityId}]`;
    switch (event.type) {
      case "wake_started":
        log(
          `${tag} wake #${event.tickNumber} (${event.trigger}) — ` +
            `${event.goalCount} goal${event.goalCount === 1 ? "" : "s"}, last wake ${ago(event.lastWakeAt)}`,
        );
        break;
      case "wake_skipped":
        log(`${tag} wake skipped — ${event.reason}`);
        break;
      case "agent_event":
        if (event.event.type === "tool_call") {
          log(`${tag} ⚙ ${event.event.name} ${clip(event.event.args, 160)}`);
        } else if (event.event.content) {
          // The model's visible thinking, one clipped line per turn.
          log(`${tag} 💭 ${clip(event.event.content, 200)}`);
        }
        break;
      case "governance": {
        const ran = event.outcome === "taken" || event.outcome === "soft_cap_overridden";
        log(
          `${tag} ${ran ? "✔" : "⛔"} ${event.actionType} — ${event.outcome}` +
            `${event.denialReason ? `: ${clip(event.denialReason, 120)}` : ""}`,
        );
        break;
      }
      case "reflection": {
        const mutations =
          event.goalMutations.length > 0
            ? ` [goals: ${event.goalMutations.map((m) => m.op).join(", ")}]`
            : "";
        log(
          `${tag} ✎ ${clip(event.ledgerEntry, 200)}${mutations} — ` +
            `next wake in ${human(event.nextWakeMinutes * 60_000)} (${clip(event.nextWakeReasoning, 120)})`,
        );
        for (const warning of event.warnings) {
          log(`${tag} ⚠ reflection: ${clip(warning, 160)}`);
        }
        break;
      }
      case "wake_completed":
        log(
          `${tag} wake #${event.tickNumber} done (${event.acted ? "acted" : "no action"}) — ` +
            `next wake at ${new Date(Date.now() + event.nextWakeMs).toLocaleTimeString()}`,
        );
        break;
      case "wake_failed":
        log(
          `${tag} ✗ wake failed: ${clip(
            event.error instanceof Error ? event.error.message : event.error,
            200,
          )}`,
        );
        break;
    }
  };
};
