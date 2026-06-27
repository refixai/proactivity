import { describe, test, expect, vi } from "vitest";
import { createTestStore } from "./memory/index.js";
import { createHeartbeat } from "./core/heartbeat.js";
import { buildTickPrompt } from "./prompts/index.js";
import type { GovernanceHandle, DispatchResult } from "./core/types.js";

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

// Simulates a framework tool call → governance.dispatch inside the tick callback.
// Each pattern tests: prompt builds, governance wraps tool execution, result flows back.

describe("integration patterns", () => {

  test("LangGraph pattern: governed tools bound at graph build time", async () => {
    // LangGraph binds tools at build time. The tool's func calls governance.dispatch.
    // Simulate: build governed tool → invoke it inside tick → verify dispatch result.
    const performed: string[] = [];

    const makeGovernedTool = (governance: GovernanceHandle) => ({
      name: "send_email",
      func: async (args: { userId: string; body: string }) => {
        const result = await governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
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

      // Simulate LangGraph tool node invoking the governed tool
      const tool = makeGovernedTool(ctx.governance);
      const outcome = await tool.func({ userId: "u1", body: "hello" });
      expect(outcome).toBe("taken");

      return { cadenceHint: { nextTickMs: 300_000, reasoning: "follow up" } };
    });

    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.status).toBe("completed");
    expect(result.actionsTakenCount).toBe(1);
    expect(performed).toEqual(["email:u1"]);
  });

  test("Anthropic/OpenAI pattern: parse response → dispatch in loop", async () => {
    // Consumer calls LLM, parses structured response, dispatches each action.
    const performed: string[] = [];

    // Simulate LLM response (parsed JSON from model output)
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

      // Simulate: call LLM → parse → dispatch loop
      const results: DispatchResult[] = [];
      for (const action of simulatedLlmResponse.actions) {
        const r = await ctx.governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
          ...action,
          perform: async () => { performed.push(action.actionType); },
        });
        results.push(r);
      }

      expect(results.every((r) => r.governanceOutcome === "taken")).toBe(true);
      return { cadenceHint: simulatedLlmResponse.cadenceHint };
    });

    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(2);
    expect(performed).toEqual(["send_slack", "create_ticket"]);
    expect(result.nextCadenceMs).toBe(600_000);
  });

  test("Vercel AI SDK pattern: governed tool() inside generateText", async () => {
    // Vercel AI SDK uses tool() with execute callback. Governance wraps execute.
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const prompt = buildTickPrompt({
        briefing: ctx.briefing,
        goals: ctx.goals,
        entityId: ctx.boundary.entityId,
        tickNumber: ctx.boundary.tickNumber,
      });

      // Simulate Vercel tool({ execute }) — governance inside execute callback
      const toolExecute = async (args: { userId: string; message: string }) => {
        const result = await ctx.governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
          actionType: "send_notification",
          target: { userId: args.userId },
          reasoning: `Notify ${args.userId}`,
          perform: async () => { performed.push(`notify:${args.userId}`); },
        });
        return result.governanceOutcome;
      };

      // Simulate generateText calling the tool across multiple steps
      const outcome1 = await toolExecute({ userId: "u1", message: "hi" });
      const outcome2 = await toolExecute({ userId: "u2", message: "hey" });
      expect(outcome1).toBe("taken");
      expect(outcome2).toBe("taken");

      return {};
    });

    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(2);
    expect(performed).toEqual(["notify:u1", "notify:u2"]);
  });

  test("Mastra pattern: agent.generate with governed actions post-parse", async () => {
    // Mastra: create Agent, call agent.generate, parse, dispatch.
    // Same as Anthropic/OpenAI but agent is instantiated per tick.
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const prompt = buildTickPrompt({
        briefing: ctx.briefing,
        goals: ctx.goals,
        entityId: ctx.boundary.entityId,
        tickNumber: ctx.boundary.tickNumber,
        extra: "You are a Mastra agent. Focus on CRM signals.",
      });

      // Verify extra field injects into prompt
      expect(prompt).toContain("Mastra agent");
      expect(prompt).toContain("Additional instructions");

      // Simulate agent.generate → parse → dispatch
      const r = await ctx.governance.dispatch({
        goalId: "g1",
        goalTickId: "gt1",
        actionType: "update_crm",
        target: { leadId: "alice" },
        reasoning: "Update lead status",
        perform: async () => { performed.push("crm_update"); },
      });
      expect(r.governanceOutcome).toBe("taken");

      return { cadenceHint: { nextTickMs: 900_000, reasoning: "low activity" } };
    });

    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(1);
    expect(performed).toEqual(["crm_update"]);
  });

  test("governance caps enforced across framework tool calls", async () => {
    // Hard cap must stop tools mid-agentic-loop regardless of framework.
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      const results: DispatchResult[] = [];
      // Simulate an agentic loop calling tools — perPass cap is 3
      for (let i = 0; i < 5; i++) {
        const r = await ctx.governance.dispatch({
          goalId: "g1",
          goalTickId: "gt1",
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

    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
    const result = await heartbeat.runTick("e1", "manual");

    expect(result.actionsTakenCount).toBe(3);
    expect(performed).toHaveLength(3);
  });

  test("idempotency dedup across retried tool calls", async () => {
    // Framework retries (LangGraph loop, Vercel maxSteps) shouldn't cause duplicate actions.
    const performed: string[] = [];

    const { store, heartbeat } = makeHeartbeat(async (ctx) => {
      // Same action dispatched twice (simulates a retry/re-invocation)
      const r1 = await ctx.governance.dispatch({
        goalId: "g1",
        goalTickId: "gt1",
        actionType: "send_email",
        target: { userId: "u1" },
        reasoning: "First attempt",
        perform: async () => { performed.push("sent"); },
      });
      const r2 = await ctx.governance.dispatch({
        goalId: "g1",
        goalTickId: "gt1",
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

    await store.upsertState("e1", { enabled: true, actionsRequireApproval: false });
    await heartbeat.runTick("e1", "manual");

    expect(performed).toEqual(["sent"]);
  });

  test("prompt builder works for all tick states", async () => {
    // Verify prompts build correctly with various goal/briefing shapes.
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
