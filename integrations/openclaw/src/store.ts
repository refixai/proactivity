/**
 * A durable, dependency-free `ProactivityStore` for a personal OpenClaw agent.
 *
 * The SDK ships a Postgres store (Oracle-scale) and an in-memory test store
 * (not durable). A personal agent wants something in between, so this persists
 * goals + the attempt ledger to a single JSON file (`~/.openclaw/proactivity.json`
 * by default), loaded on `migrate()` and rewritten on each mutation.
 *
 * Single-writer by contract: the OpenClaw gateway is one process and runs cron +
 * agent turns in-process, so there is exactly one writer. The whole-file write is
 * last-writer-wins; a second concurrent writer process would clobber it. For any
 * multi-writer/multi-process deployment, use the SDK's Postgres store instead.
 *
 * Only the methods the governance envelope and the tools actually call are
 * implemented; the heartbeat/scheduler methods throw, since OpenClaw drives its
 * own loop and this integration never runs the SDK scheduler.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ActionAttempt,
  GoalRecord,
  InsertAttempt,
  InsertAttemptResult,
  ProactivityStore,
} from "@refixai/proactivity";

const reviveGoal = (g: GoalRecord): GoalRecord => ({
  ...g,
  lastWorkedAt: g.lastWorkedAt ? new Date(g.lastWorkedAt) : null,
  createdAt: new Date(g.createdAt),
  updatedAt: new Date(g.updatedAt),
});

const reviveAttempt = (a: ActionAttempt): ActionAttempt => ({
  ...a,
  attemptedAt: new Date(a.attemptedAt),
  completedAt: a.completedAt ? new Date(a.completedAt) : null,
});

export const createJsonStore = (filePath: string, entityId: string): ProactivityStore => {
  let goals: GoalRecord[] = [];
  let attempts: ActionAttempt[] = [];

  const load = () => {
    if (!existsSync(filePath)) return;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      goals?: GoalRecord[];
      attempts?: ActionAttempt[];
    };
    goals = (raw.goals ?? []).map(reviveGoal);
    attempts = (raw.attempts ?? []).map(reviveAttempt);
  };

  const save = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    // Atomic write: a crash mid-write must not truncate the durable store.
    // Write a temp file, then rename over the target (atomic on POSIX, same dir).
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ goals, attempts }), "utf8");
    renameSync(tmp, filePath);
  };

  // Heartbeat/scheduler methods this integration never calls. A throw is louder
  // and safer than a silent wrong answer if the wiring ever changes.
  const notSupported =
    (name: string) =>
    (): never => {
      throw new Error(`proactivity-openclaw: store.${name}() is not used by this integration`);
    };

  return {
    async migrate() {
      load();
    },

    // --- goals ---
    async listGoals(_entityId, filter) {
      return goals.filter((g) => !filter?.status || filter.status.includes(g.status));
    },
    async getGoal(goalId) {
      return goals.find((g) => g.id === goalId) ?? null;
    },
    async applyGoalMutations(_tickId, mutations) {
      const now = new Date();
      for (const m of mutations) {
        if (m.op === "create") {
          goals.push({
            id: m.goalId ?? randomUUID(),
            entityId,
            title: m.title ?? "",
            objective: m.objective ?? "",
            doneCondition: m.doneCondition ?? "",
            findings: m.findings ?? "",
            nextActions: m.nextActions ?? null,
            creationReasoning: m.reasoning,
            status: "active",
            priority: m.priority ?? "medium",
            lastWorkedAt: null,
            createdAt: now,
            updatedAt: now,
          });
          continue;
        }
        const g = goals.find((x) => x.id === m.goalId);
        if (!g) continue;
        g.updatedAt = now;
        if (m.op === "update") {
          if (m.title !== undefined) g.title = m.title;
          if (m.objective !== undefined) g.objective = m.objective;
          if (m.doneCondition !== undefined) g.doneCondition = m.doneCondition;
          if (m.findings !== undefined) g.findings = m.findings;
          if (m.nextActions !== undefined) g.nextActions = m.nextActions;
          if (m.priority !== undefined) g.priority = m.priority;
        } else if (m.op === "reprioritize") {
          if (m.priority !== undefined) g.priority = m.priority;
        } else if (m.op === "complete") {
          g.status = "completed";
        } else if (m.op === "archive") {
          g.status = "archived";
        } else if (m.op === "pause") {
          g.status = "paused";
        }
      }
      save();
    },

    // --- attempts (the governance ledger) ---
    async insertAttempt(a: InsertAttempt): Promise<InsertAttemptResult> {
      const existing = attempts.find((x) => x.idempotencyKey === a.idempotencyKey);
      if (existing) {
        return {
          kind: "idempotency_conflict",
          prior: { attemptId: existing.id, outcome: existing.governanceOutcome },
        };
      }
      const attemptId = randomUUID();
      attempts.push({
        id: attemptId,
        goalId: a.goalId,
        tickId: a.tickId,
        goalTickId: a.goalTickId,
        actionType: a.actionType,
        idempotencyKey: a.idempotencyKey,
        governanceOutcome: a.governanceOutcome,
        reasoning: a.reasoning,
        denialReason: a.denialReason,
        overrideReason: a.overrideReason,
        target: a.target,
        payload: a.payload ?? null,
        attemptedAt: new Date(),
        completedAt: null,
        error: null,
      });
      save();
      return { kind: "inserted", attemptId };
    },
    async markAttemptCompleted(attemptId) {
      const a = attempts.find((x) => x.id === attemptId);
      if (!a) return;
      a.completedAt = new Date();
      save();
    },
    async markAttemptFailed(attemptId, error) {
      const a = attempts.find((x) => x.id === attemptId);
      if (!a) return;
      a.error = error;
      save();
    },
    async getRecentAttempts(_entityId, opts) {
      // Recent = attempts from the most recent `tickWindow` distinct ticks.
      const order: string[] = [];
      for (const a of [...attempts].reverse()) {
        if (!order.includes(a.tickId)) order.push(a.tickId);
      }
      const recent = new Set(order.slice(0, opts.tickWindow));
      return attempts.filter((a) => recent.has(a.tickId)).reverse();
    },

    getState: notSupported("getState"),
    upsertState: notSupported("upsertState"),
    insertTick: notSupported("insertTick"),
    updateTick: notSupported("updateTick"),
    getLatestTick: notSupported("getLatestTick"),
    getPreviousTickStartedAt: notSupported("getPreviousTickStartedAt"),
    insertGoalTick: notSupported("insertGoalTick"),
    updateGoalTick: notSupported("updateGoalTick"),
    listAttempts: notSupported("listAttempts"),
    listSchedulableEntities: notSupported("listSchedulableEntities"),
  };
};
