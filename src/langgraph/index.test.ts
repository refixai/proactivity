import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestStore } from "../memory/index.js";
import { proactive } from "../proactive/proactive.js";
import type { ReasoningModel } from "../proactive/types.js";
import {
  createTranscriptRecorder,
  fromLangGraph,
  governed,
  langchainModel,
} from "./index.js";

// --- Test doubles -----------------------------------------------------------

// A deterministic chat model: plays back a fixed queue of AIMessages, one per
// model turn, and records every message list it was shown. No network, no
// randomness — if the agent loops longer than the script, it throws.
class ScriptedChatModel extends BaseChatModel {
  private readonly queue: AIMessage[];
  readonly seen: BaseMessage[][] = [];

  constructor(responses: AIMessage[]) {
    super({});
    this.queue = [...responses];
  }

  _llmType(): string {
    return "scripted";
  }

  // createReactAgent binds its tools to the model; the script already knows
  // what it's going to say, so binding is a no-op.
  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const message = this.queue.shift();
    if (!message) throw new Error("ScriptedChatModel exhausted — runaway agent loop");
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
}

const makeReflectionModel = (): { model: ReasoningModel; prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    model: {
      async generate(prompt) {
        prompts.push(prompt);
        return {
          ledgerEntry: "briefed u1 once; duplicate suppressed",
          goalMutations: [],
          nextWakeMinutes: 60,
          nextWakeReasoning: "steady state",
        };
      },
    },
  };
};

const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
  name,
  args,
  id,
  type: "tool_call" as const,
});

// --- End to end: a real ReAct graph through the full wake pipeline -----------

describe("fromLangGraph through proactive()", () => {
  test("unchanged createReactAgent: report in, governed dedupe, full transcript to reflection", async () => {
    // Turn 1: read something, then send the brief. Turn 2: hallucinate the
    // same send again. Turn 3: stop.
    const scripted = new ScriptedChatModel([
      new AIMessage({
        content: "",
        tool_calls: [
          toolCall("lookup", { q: "signups" }, "c1"),
          toolCall("send_brief", { userId: "u1" }, "c2"),
        ],
      }),
      new AIMessage({
        content: "",
        tool_calls: [toolCall("send_brief", { userId: "u1" }, "c3")],
      }),
      new AIMessage("all done"),
    ]);

    const sent: string[] = [];
    const lookup = tool(async ({ q }) => `found: ${q}`, {
      name: "lookup",
      description: "Look something up (read-only)",
      schema: z.object({ q: z.string() }),
    });
    const sendBrief = governed(
      tool(
        async ({ userId }: { userId: string }) => {
          sent.push(userId);
          return "sent";
        },
        {
          name: "send_brief",
          description: "Deliver the brief",
          schema: z.object({ userId: z.string() }),
        },
      ),
      { target: (args) => ({ userId: args.userId as string }) },
    );

    // The agent is built exactly the way a user would build it — nothing
    // proactivity-specific inside.
    const agent = createReactAgent({ llm: scripted, tools: [lookup, sendBrief] });

    const store = createTestStore();
    const { model, prompts } = makeReflectionModel();
    const handle = proactive(fromLangGraph(agent), { model, store });

    await handle.wake("workspace-1");

    // The side effect ran exactly once — the second send was idempotency-denied.
    expect(sent).toEqual(["u1"]);

    // The situation report reached the model as the wake's user message.
    const firstTurn = scripted.seen[0]!;
    const humanText = firstTurn
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(humanText).toContain("Situation report");
    expect(humanText).toContain("wake #1");

    // The duplicate came back to the model in-band as a governance denial.
    const secondTurn = scripted.seen.at(-1)!;
    const toolResults = secondTurn
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(toolResults).toContain("hard_denied");

    // The audit trail agrees: one taken, no second row for the duplicate.
    const tick = (await store.getLatestTick("workspace-1"))!;
    const attempts = await store.listAttempts(tick.id);
    expect(attempts.map((a) => a.governanceOutcome)).toEqual(["taken"]);
    expect(attempts[0]!.target).toEqual({ userId: "u1" });

    // Reflection saw the whole run: the read, the send, the denial, the finale.
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain("[tool] lookup");
    expect(prompt).toContain("found: signups");
    expect(prompt).toContain("[tool] send_brief");
    expect(prompt).toContain("hard_denied");
    expect(prompt).toContain("[final] all done");

    // And its ledger entry landed on the wake.
    const goalTicks = await store.listGoalTicks(tick.id);
    expect(goalTicks[0]!.summary).toContain("duplicate suppressed");
    expect(goalTicks[0]!.acted).toBe(true);
  });

  test("governed tools pass through untouched outside a wake (normal reactive use)", async () => {
    const sent: string[] = [];
    const sendBrief = governed(
      tool(
        async ({ userId }: { userId: string }) => {
          sent.push(userId);
          return "sent";
        },
        {
          name: "send_brief",
          description: "Deliver the brief",
          schema: z.object({ userId: z.string() }),
        },
      ),
    );

    const result = await sendBrief.invoke({ userId: "u9" });
    expect(sent).toEqual(["u9"]);
    expect(result).toBe("sent");
  });
});

// --- Units --------------------------------------------------------------------

describe("createTranscriptRecorder", () => {
  test("normalizes tool starts/ends/errors and model turns into Transcript events", () => {
    const recorder = createTranscriptRecorder();

    recorder.handler.handleToolStart(
      { id: ["langchain", "tools", "DynamicStructuredTool"] },
      JSON.stringify({ q: "x" }),
      "run-1",
      undefined,
      undefined,
      undefined,
      "lookup",
    );
    recorder.handler.handleToolEnd({ content: "found it" }, "run-1");

    recorder.handler.handleToolStart({ name: "explode" }, "not json", "run-2");
    recorder.handler.handleToolError(new Error("boom"), "run-2");

    recorder.handler.handleLLMEnd(
      { generations: [[{ text: "thinking out loud" }]] },
      "run-3",
    );

    const transcript = recorder.transcript("the end");
    expect(transcript.events).toEqual([
      { type: "tool_call", name: "lookup", args: { q: "x" }, result: "found it" },
      { type: "tool_call", name: "explode", args: "not json", result: "boom", isError: true },
      { type: "model", content: "thinking out loud" },
    ]);
    expect(transcript.finalOutput).toBe("the end");
  });
});

describe("langchainModel", () => {
  test("routes reflection through withStructuredOutput on the dev's own model", async () => {
    const calls: Array<{ schema: Record<string, unknown>; prompt: string }> = [];
    const fake = {
      withStructuredOutput(schema: Record<string, unknown>) {
        return {
          invoke: async (prompt: string) => {
            calls.push({ schema, prompt });
            return { ok: true };
          },
        };
      },
    };

    const model = langchainModel(fake);
    const result = await model.generate("reflect on this", { type: "object" });
    expect(result).toEqual({ ok: true });
    expect(calls[0]!.schema).toEqual({ type: "object" });
    expect(calls[0]!.prompt).toBe("reflect on this");
  });
});
