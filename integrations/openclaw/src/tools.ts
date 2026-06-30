/**
 * The three proactivity tools, in OpenClaw's tool shape (TypeBox `parameters`,
 * an `execute(id, params)` that returns `{ content: [{ type, text }] }`).
 *
 * `goal` and `briefing` are fully in-process over the JSON store. `set_cadence`
 * is best-effort: a workspace plugin can't call `scheduleSessionTurn` (it's
 * gated to bundled plugins), so cadence rides the `openclaw cron` CLI.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import {
  type GoalMutation,
  type ProactivityStore,
  validateGoalMutations,
} from "@refixai/proactivity";

const exec = promisify(execFile);

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  details: null,
});

const TICK_PROMPT =
  "Proactivity tick. Call `briefing` to review your goal portfolio and recent actions. Investigate " +
  "before acting — most ticks should end with no outbound message. Use `goal` to keep the portfolio " +
  "tight, and only send when a goal genuinely warrants it (governance enforces your rate limits).";

const GoalParams = Type.Object({
  op: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("complete"),
      Type.Literal("archive"),
      Type.Literal("pause"),
      Type.Literal("reprioritize"),
    ],
    { description: "What to do to the goal portfolio." },
  ),
  goalId: Type.Optional(Type.String({ description: "Required for every op except create." })),
  title: Type.Optional(Type.String({ description: "Required for create." })),
  objective: Type.Optional(Type.String()),
  doneCondition: Type.Optional(Type.String({ description: "How you'll know this goal is done." })),
  findings: Type.Optional(Type.String()),
  nextActions: Type.Optional(Type.String()),
  priority: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
  ),
  reasoning: Type.String({ description: "Why you're making this change." }),
});

export const goalTool = (store: ProactivityStore) => ({
  name: "goal",
  label: "Manage goals",
  description:
    "Manage your durable goals — missions that persist across proactive ticks, each with a " +
    "done-condition. Create one when you spot a real signal worth pursuing; update findings as you " +
    "learn; complete or archive to keep the portfolio tight.",
  parameters: GoalParams,
  async execute(_id: string, params: Static<typeof GoalParams>) {
    const goalId = params.op === "create" ? randomUUID() : params.goalId;
    const mutation: GoalMutation = {
      op: params.op,
      goalId,
      title: params.title,
      objective: params.objective,
      doneCondition: params.doneCondition,
      findings: params.findings,
      nextActions: params.nextActions,
      priority: params.priority,
      reasoning: params.reasoning,
    };
    const errors = validateGoalMutations([mutation]);
    if (errors.length) return text({ error: errors.join("; ") });
    await store.applyGoalMutations("", [mutation]);
    const goal = goalId ? await store.getGoal(goalId) : null;
    if (goalId && goal === null) return text({ error: `goal '${goalId}' not found` });
    return text({ goal });
  },
});

export const briefingTool = (store: ProactivityStore, entityId: string) => ({
  name: "briefing",
  label: "Proactive briefing",
  description:
    "Your proactive briefing: the active goal portfolio plus the actions you've recently taken or " +
    "been blocked from taking. Call this first on a proactive tick.",
  parameters: Type.Object({}),
  async execute() {
    const goals = await store.listGoals(entityId, { status: ["active", "paused"] });
    const recent = await store.getRecentAttempts(entityId, { tickWindow: 5 });
    return text({
      goals,
      recentActions: recent.map((a) => ({
        action: a.actionType,
        outcome: a.governanceOutcome,
        target: a.target,
        denialReason: a.denialReason,
      })),
    });
  },
});

const CadenceParams = Type.Object({
  schedule: Type.String({ description: "e.g. 'every 1h', 'every 30m', or a cron expression." }),
  reasoning: Type.Optional(Type.String()),
});

export const setCadenceTool = (opts: { sessionKey?: string }) => ({
  name: "set_cadence",
  label: "Set cadence",
  description:
    "Set how soon you wake up for your next proactive tick. Accepts 'every 30m', 'every 2h', or a " +
    "cron expression. Match the interval to what you're waiting for.",
  parameters: CadenceParams,
  async execute(_id: string, params: Static<typeof CadenceParams>) {
    const schedule = (params.schedule ?? "").trim();
    if (!schedule) return text({ error: "schedule is required (e.g. 'every 1h')" });

    const scheduleFlag = schedule.toLowerCase().startsWith("every ")
      ? ["--every", schedule.slice(6).trim()]
      : ["--cron", schedule];
    const addArgs = ["cron", "add", "--name", "proactivity-tick", ...scheduleFlag, "--message", TICK_PROMPT];
    if (opts.sessionKey) addArgs.push("--session-key", opts.sessionKey);

    try {
      // Best-effort upsert: drop any prior tick job, then add the new one.
      // ponytail: shelling the CLI is the only cadence path for a workspace
      // plugin (scheduleSessionTurn is bundled-only); real fix = upstream
      // programmatic scheduling. See README.
      await exec("openclaw", ["cron", "rm", "proactivity-tick"]).catch(() => {});
      const { stdout } = await exec("openclaw", addArgs);
      return text({ scheduled: true, schedule, detail: stdout.trim().slice(0, 200) });
    } catch (e) {
      return text({ error: `could not set cadence via 'openclaw cron': ${(e as Error).message}` });
    }
  },
});
