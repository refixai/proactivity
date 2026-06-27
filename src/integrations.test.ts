import { describe, test, expect, vi } from "vitest";
import { createTestStore } from "./memory/index.js";
import { createHeartbeat } from "./core/heartbeat.js";
import { buildTickPrompt } from "./prompts/index.js";
import type { GovernanceHandle, DispatchResult, ProactivityStore } from "./core/types.js";

const makeHeartbeat = (tickFn: Parameters<typeof createHeartbeat>[0]["tick"]) => {
  const store = createTestStore();
  return { store, heartbeat: createHeartbeat({
    store,
    sources: [{ name: "crm", load: async () => ({ newLead: "Alice" }) }],
    governance: { store, caps: { perPass: 3, perTick: 5 } },
    cadence: { min: 60_000, max: 86_400_000, default: 3_600_000 },
    tick: tickFn,
  })};
};

const seedGoalAndGoalTick = async (store: ProactivityStore, tickId: string, goalId: string) => {
  await store.applyGoalMutations(tickId, [
    { op: "create", goalId, title: "Test goal", objective: "o", doneCondition: "d", findings: "", reasoning: "r" },
  ]);
  const goalTickId = await store.insertGoalTick({ goalId, tickId, orderIndex: 0 });
  return goalTickId;
};

describe("integration patterns", () => {

  test("LangGraph pattern: governed tools bound at graph build time", async () => {
    const performed: string[] = [];

    const makeGovernedTool = (governance: GovernanceHandle, goalId: string, goalTickId: string) => ({
      name: "send_email",
      func: async (args: { userId: string; body: string }) => {
        const result = await governance.dispatch({
          goalId,
          goalTickId,
          actionType: "send_email",
          target: { userId: args.userId },
          reasoning: `Email to ${args.userId}`,
          perform: async () => { performed.push(`email:${args.userId}`); },
        });
        return result.governanceOutcome;
      },
    });

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const prompt = buildTickPrompt({
        briefing: ctx.briefing,
        goals: ctx.goals,
        entityId: ctx.boundary.entityId,
        tickNumber: ctx.boundary.tickNumber,
      });
      expect(typeof prompt).toBe("string");
      expect(prompt).toContain("crm");

      const goalTickId = await seedGoalAndGoalTick(store, ctx.boundary.tickId, "g-lang");
      const tool = makeGovernedTool(ctx.governance, "g-lang", goalTickId);
      const outcome = await tool.func({ userId: "u1", body: "hello" });
      expect(outcome).toBe("taken");

      return { cadenceHint: { nextTickMs: 300_000, reasoning: "follow up" } };
    });

    await store.upsertState("e1", { enabled: true });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.status).toBe("completed");
    expect(result.actionsTakenCount).toBe(1);
    expect(performed).toEqual(["email:u1"]);
  });

  test("Anthropic/OpenAI pattern: parse response → dispatch in loop", async () => {
    const performed: string[] = [];

    const simulatedLlmResponse = {
      actions: [
        { actionType: "send_slack", target: { channel: "#general" }, reasoning: "alert team" },
        { actionType: "create_ticket", target: { project: "PROJ" }, reasoning: "track issue" },
      ],
      cadenceHint: { nextTickMs: 600_000, reasoning: "waiting on response" },
    };

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const prompt = buildTickPrompt({
        briefing: ctx.briefing,
        goals: ctx.goals,
        entityId: ctx.boundary.entityId,
        tickNumber: ctx.boundary.tickNumber,
      });
      expect(prompt.length).toBeGreaterThan(100);

      const goalTickId = await seedGoalAndGoalTick(store, ctx.boundary.tickId, "g-anthropic");

      const results: DispatchResult[] = [];
      for (const action of simulatedLlmResponse.actions) {
        const r = await ctx.governance.dispatch({
          goalId: "g-anthropic",
          goalTickId,
          ...action,
          perform: async () => { performed.push(action.actionType); },
        });
        results.push(r);
      }

      expect(results.every((r) => r.governanceOutcome === "taken")).toBe(true);
      return { cadenceHint: simulatedLlmResponse.cadenceHint };
    });

    await store.upsertState("e1", { enabled: true });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(2);
    expect(performed).toEqual(["send_slack", "create_ticket"]);
    expect(result.nextCadenceMs).toBe(600_000);
  });

  test("Vercel AI SDK pattern: governed tool() inside generateText", async () => {
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      buildTickPrompt({
        briefing: ctx.briefing,
        goals: ctx.goals,
        entityId: ctx.boundary.entityId,
        tickNumber: ctx.boundary.tickNumber,
      });

      const goalTickId = await seedGoalAndGoalTick(store, ctx.boundary.tickId, "g-vercel");

      const toolExecute = async (args: { userId: string; message: string }) => {
        const result = await ctx.governance.dispatch({
          goalId: "g-vercel",
          goalTickId,
          actionType: "send_notification",
          target: { userId: args.userId },
          reasoning: `Notify ${args.userId}`,
          perform: async () => { performed.push(`notify:${args.userId}`); },
        });
        return result.governanceOutcome;
      };

      const outcome1 = await toolExecute({ userId: "u1", message: "hi" });
      const outcome2 = await toolExecute({ userId: "u2", message: "hey" });
      expect(outcome1).toBe("taken");
      expect(outcome2).toBe("taken");

      return {};
    });

    await store.upsertState("e1", { enabled: true });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(2);
    expect(performed).toEqual(["notify:u1", "notify:u2"]);
  });

  test("Mastra pattern: agent.generate with governed actions post-parse", async () => {
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const prompt = buildTickPrompt({
        briefing: ctx.briefing,
        goals: ctx.goals,
        entityId: ctx.boundary.entityId,
        tickNumber: ctx.boundary.tickNumber,
        extra: "You are a Mastra agent. Focus on CRM signals.",
      });

      expect(prompt).toContain("Mastra agent");
      expect(prompt).toContain("Additional instructions");

      const goalTickId = await seedGoalAndGoalTick(store, ctx.boundary.tickId, "g-mastra");

      const r = await ctx.governance.dispatch({
        goalId: "g-mastra",
        goalTickId,
        actionType: "update_crm",
        target: { leadId: "alice" },
        reasoning: "Update lead status",
        perform: async () => { performed.push("crm_update"); },
      });
      expect(r.governanceOutcome).toBe("taken");

      return { cadenceHint: { nextTickMs: 900_000, reasoning: "low activity" } };
    });

    await store.upsertState("e1", { enabled: true });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(1);
    expect(performed).toEqual(["crm_update"]);
  });

  test("governance caps enforced across framework tool calls", async () => {
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const goalTickId = await seedGoalAndGoalTick(store, ctx.boundary.tickId, "g-caps");

      const results: DispatchResult[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await ctx.governance.dispatch({
          goalId: "g-caps",
          goalTickId,
          actionType: "send_message",
          target: { userId: `u${i}` },
          reasoning: `Message ${i}`,
          perform: async () => { performed.push(`msg:${i}`); },
        });
        results.push(r);
      }

      const taken = results.filter((r) => r.governanceOutcome === "taken");
      const denied = results.filter((r) => r.governanceOutcome === "hard_denied");
      expect(taken).toHaveLength(3);
      expect(denied).toHaveLength(2);

      return {};
    });

    await store.upsertState("e1", { enabled: true });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(3);
    expect(performed).toHaveLength(3);
  });

  test("idempotency dedup across retried tool calls", async () => {
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const goalTickId = await seedGoalAndGoalTick(store, ctx.boundary.tickId, "g-idemp");

      const r1 = await ctx.governance.dispatch({
        goalId: "g-idemp",
        goalTickId,
        actionType: "send_email",
        target: { userId: "u1" },
        reasoning: "First attempt",
        perform: async () => { performed.push("sent"); },
      });
      const r2 = await ctx.governance.dispatch({
        goalId: "g-idemp",
        goalTickId,
        actionType: "send_email",
        target: { userId: "u1" },
        reasoning: "Retry",
        perform: async () => { performed.push("sent-again"); },
      });

      expect(r1.governanceOutcome).toBe("taken");
      expect(r2.governanceOutcome).toBe("hard_denied");
      expect(r2.denialReason).toContain("idempotency");

      return {};
    });

    await store.upsertState("e1", { enabled: true });
    await heartbeat.runTick("e1", "manual");

    expect(performed).toEqual(["sent"]);
  });

  test("prompt builder works for all tick states", async () => {
    const prompt1 = buildTickPrompt({
      briefing: {},
      goals: [],
      entityId: "e1",
      tickNumber: 1,
    });
    expect(prompt1).toContain("(no goals yet)");
    expect(prompt1).toContain("tick #1");

    const prompt2 = buildTickPrompt({
      briefing: { signals: [1, 2, 3], nested: { deep: true } },
      goals: [{
        id: "g1", entityId: "e1", title: "Engage Alice",
        objective: "Send intro email", doneCondition: "Reply received",
        findings: "New lead", nextActions: null, creationReasoning: "r",
        status: "active", priority: "high",
        lastWorkedAt: null, createdAt: new Date(), updatedAt: new Date(),
      }],
      entityId: "e1",
      tickNumber: 5,
      extra: "Custom consumer instructions here.",
    });
    expect(prompt2).toContain("Engage Alice");
    expect(prompt2).toContain("active/high");
    expect(prompt2).toContain("tick #5");
    expect(prompt2).toContain("Custom consumer instructions");
    expect(prompt2).toContain('"deep": true');
  });
});
